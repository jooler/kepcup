import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryKeystore, type CoreHarness } from '@kepcup/core';
import { createTestCore, makeBot } from '@kepcup/testkit';
import type { Bot } from '@kepcup/shared';

const cores: CoreHarness[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const core of cores.splice(0)) await core.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

describe('bot avatars (upload / read / validation)', () => {
  it('upload writes bots/{id}/avatar/, points identity.avatar at it and reads back the bytes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');

    const uploaded = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { bot: Bot };
    expect(uploaded.bot.avatar).toMatch(/^upload:avatar-\d+\.png$/);
    expect(uploaded.bot.profile.identity.avatar).toBe(uploaded.bot.avatar);
    expect(uploaded.bot.name).toBe('小启');

    const dir = path.join(home, 'bots', bot.id, 'avatar');
    const files = await readdir(dir);
    expect(files).toEqual([uploaded.bot.avatar!.slice('upload:'.length)]);
    expect(await readFile(path.join(dir, files[0]!))).toEqual(PNG_1PX);

    const data = (await core.rpc.call('bots.avatar.data', {
      id: bot.id,
      file: uploaded.bot.avatar!.slice('upload:'.length),
    })) as { mime: string; base64: string };
    expect(data.mime).toBe('image/png');
    expect(Buffer.from(data.base64, 'base64')).toEqual(PNG_1PX);
  });

  it('stores SVG avatars as-is and reads them back with the SVG mime', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');

    const uploaded = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/svg+xml',
      bytesBase64: SVG.toString('base64'),
    })) as { bot: Bot };
    expect(uploaded.bot.avatar).toMatch(/^upload:avatar-\d+\.svg$/);

    const data = (await core.rpc.call('bots.avatar.data', {
      id: bot.id,
      file: uploaded.bot.avatar!.slice('upload:'.length),
    })) as { mime: string; base64: string };
    expect(data.mime).toBe('image/svg+xml');
    expect(Buffer.from(data.base64, 'base64')).toEqual(SVG);
  });

  it('a second upload replaces the file, resets the slot and rejects reads of the stale name', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');

    const first = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { bot: Bot };
    const second = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/jpeg',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { bot: Bot };
    expect(second.bot.avatar).not.toBe(first.bot.avatar);

    const files = await readdir(path.join(home, 'bots', bot.id, 'avatar'));
    expect(files).toHaveLength(1);
    await expect(
      core.rpc.call('bots.avatar.data', {
        id: bot.id,
        file: first.bot.avatar!.slice('upload:'.length),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects unsupported mimes, oversized payloads, path traversal and unknown files', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');

    await expect(
      core.rpc.call('bots.avatar.upload', {
        id: bot.id,
        mime: 'image/gif',
        bytesBase64: PNG_1PX.toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      core.rpc.call('bots.avatar.upload', {
        id: bot.id,
        mime: 'image/png',
        bytesBase64: Buffer.alloc(3_000_001).toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      core.rpc.call('bots.avatar.data', { id: bot.id, file: '../main.db' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      core.rpc.call('bots.avatar.data', { id: bot.id, file: 'avatar-1.png' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('avatar mask defaults to circle, round-trips through bots.avatar.mask and survives avatar changes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');
    // 新建行的 avatar_mask 是 NULL（0060 之后的旧数据同形）：读出归一为 circle。
    expect(bot.avatarMask).toBe('circle');

    const rounded = (await core.rpc.call('bots.avatar.mask', {
      id: bot.id,
      mask: 'rounded',
    })) as { bot: Bot };
    expect(rounded.bot.avatarMask).toBe('rounded');

    // 遮罩单独成列：换上传头像 / 换预置头像都不动它，重新上传仍沿用上次形状。
    const uploaded = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { bot: Bot };
    expect(uploaded.bot.avatarMask).toBe('rounded');
    const preset = (await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        identity: { ...bot.profile.identity, avatar: 'preset:orb:orange' },
      },
    })) as { bot: Bot };
    expect(preset.bot.avatarMask).toBe('rounded');
    const refetched = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(refetched.bot.avatarMask).toBe('rounded');

    const circle = (await core.rpc.call('bots.avatar.mask', {
      id: bot.id,
      mask: 'circle',
    })) as { bot: Bot };
    expect(circle.bot.avatarMask).toBe('circle');

    // 枚举之外的取值在 RPC 边界就被拦下。
    await expect(
      core.rpc.call('bots.avatar.mask', { id: bot.id, mask: 'square' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 不存在的 Bot 不能写遮罩。
    await expect(
      core.rpc.call('bots.avatar.mask', { id: 'bot_missing', mask: 'rounded' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('preset avatar strings round-trip through bots.update without touching the disk', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');

    const updated = (await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        identity: { ...bot.profile.identity, avatar: 'preset:orb:orange' },
      },
    })) as { bot: Bot };
    expect(updated.bot.avatar).toBe('preset:orb:orange');
    await expect(readdir(path.join(home, 'bots', bot.id, 'avatar'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
