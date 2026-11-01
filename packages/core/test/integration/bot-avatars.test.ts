import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryKeystore, type CoreHarness } from '@kepcup/core';
import { createTestCore, makeBot, waitForEvent } from '@kepcup/testkit';
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
    // 领域层直接调用（不经 RPC 校验）也应归一为 INVALID_INPUT，而不是裸 ZodError。
    expect(() => core.services.domain!.bots.setAvatarMask(bot.id, 'square' as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('avatar padding defaults to 0, round-trips through bots.avatar.padding and survives avatar changes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');
    // 新建行的 avatar_padding 是 NULL（0061 之后的旧数据同形）：读出归一为 0。
    expect(bot.avatarPadding).toBe(0);

    const padded = (await core.rpc.call('bots.avatar.padding', {
      id: bot.id,
      padding: 4,
    })) as { bot: Bot };
    expect(padded.bot.avatarPadding).toBe(4);

    // 边距单独成列：换上传头像 / 换预置头像都不动它，重新上传仍沿用上次的边距。
    const uploaded = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { bot: Bot };
    expect(uploaded.bot.avatarPadding).toBe(4);
    const preset = (await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        identity: { ...bot.profile.identity, avatar: 'preset:orb:orange' },
      },
    })) as { bot: Bot };
    expect(preset.bot.avatarPadding).toBe(4);
    const refetched = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(refetched.bot.avatarPadding).toBe(4);

    const zeroed = (await core.rpc.call('bots.avatar.padding', {
      id: bot.id,
      padding: 0,
    })) as { bot: Bot };
    expect(zeroed.bot.avatarPadding).toBe(0);

    // 范围（0-16）与整数约束在 RPC 边界就被拦下。
    await expect(
      core.rpc.call('bots.avatar.padding', { id: bot.id, padding: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      core.rpc.call('bots.avatar.padding', { id: bot.id, padding: 17 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      core.rpc.call('bots.avatar.padding', { id: bot.id, padding: 1.5 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 不存在的 Bot 不能写边距。
    await expect(
      core.rpc.call('bots.avatar.padding', { id: 'bot_missing', padding: 4 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 领域层直接调用（不经 RPC 校验）也应归一为 INVALID_INPUT，而不是裸 ZodError。
    expect(() => core.services.domain!.bots.setAvatarPadding(bot.id, 99)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('accent color is independent of the avatar: upload never resets it, preset writes keep it', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');
    // 旧数据形状（没设置过强调色）：读回不带该字段，渲染端回退到预置头像色 / mono。
    expect(bot.accentColor).toBeUndefined();

    // 新建即带预置头像的 Bot 会把内嵌色落成显式列（旧逻辑里颜色只活在串里，
    // 一换上传头像就丢——用户报的那个 bug）。
    const presetBot = (await core.rpc.call('bots.create', {
      profile: {
        ...bot.profile,
        identity: { ...bot.profile.identity, avatar: 'preset:heart:red' },
      },
    })) as { bot: Bot };
    expect(presetBot.bot.accentColor).toBe('red');

    // 写入 + 广播：bots.accent.color 单独成列，不发整份 Profile。
    const updated = waitForEvent<{ bot: Bot }>(core, 'bot.updated', (payload) =>
      Boolean(payload?.bot && payload.bot.id === bot.id),
    );
    const written = (await core.rpc.call('bots.accent.color', {
      id: bot.id,
      color: 'blue',
    })) as { bot: Bot };
    expect(written.bot.accentColor).toBe('blue');
    expect((await updated).bot.accentColor).toBe('blue');

    // 上传 / 换图 / 改遮罩 / 改内边距都不许碰强调色。
    const uploaded = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { bot: Bot };
    expect(uploaded.bot.accentColor).toBe('blue');
    const masked = (await core.rpc.call('bots.avatar.mask', {
      id: bot.id,
      mask: 'rounded',
    })) as { bot: Bot };
    expect(masked.bot.accentColor).toBe('blue');
    const padded = (await core.rpc.call('bots.avatar.padding', {
      id: bot.id,
      padding: 3,
    })) as { bot: Bot };
    expect(padded.bot.accentColor).toBe('blue');

    // 预置头像的 bots.update 也不动强调色。
    const preset = (await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        identity: { ...bot.profile.identity, avatar: 'preset:orb:orange' },
      },
    })) as { bot: Bot };
    expect(preset.bot.accentColor).toBe('blue');

    // 改强调色时同步改写预置串的颜色段：只认内嵌色的旧客户端也跟着变。
    const rewritten = (await core.rpc.call('bots.accent.color', {
      id: bot.id,
      color: 'teal',
    })) as { bot: Bot };
    expect(rewritten.bot.accentColor).toBe('teal');
    expect(rewritten.bot.avatar).toBe('preset:orb:teal');

    // 上传头像串没有颜色段，改强调色不动它。
    const uploadedAgain = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { bot: Bot };
    const recolored = (await core.rpc.call('bots.accent.color', {
      id: bot.id,
      color: 'purple',
    })) as { bot: Bot };
    expect(recolored.bot.accentColor).toBe('purple');
    expect(recolored.bot.avatar).toBe(uploadedAgain.bot.avatar);

    // 枚举之外的取值在 RPC 边界就被拦下；不存在的 Bot 不能写。
    await expect(
      core.rpc.call('bots.accent.color', { id: bot.id, color: 'chartreuse' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      core.rpc.call('bots.accent.color', { id: 'bot_missing', color: 'red' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 领域层直接调用（不经 RPC 校验）也归一为 INVALID_INPUT，而不是裸 ZodError。
    expect(() =>
      core.services.domain!.bots.setAccentColor(bot.id, 'chartreuse' as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('deleting a bot clears its accent color with the rest of the avatar state', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);
    const bot = await makeBot(core, '小启');
    await core.rpc.call('bots.accent.color', { id: bot.id, color: 'amber' });
    await core.rpc.call('bots.delete', { id: bot.id });
    const placeholder = core.services.domain!.bots.get(bot.id);
    expect(placeholder?.status).toBe('deleted');
    expect(placeholder?.accentColor).toBeUndefined();
    expect(placeholder?.avatar).toBeNull();
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
