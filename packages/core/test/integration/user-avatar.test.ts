import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryKeystore, type CoreHarness } from '@kepcup/core';
import { createTestCore } from '@kepcup/testkit';
import type { Settings } from '@kepcup/shared';

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

describe('user avatar (profile settings RPC)', () => {
  it('upload writes user/avatar/, points settings.userProfileAvatar at it and reads back the bytes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-user-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);

    const uploaded = (await core.rpc.call('user.avatar.upload', {
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { avatar: string };
    expect(uploaded.avatar).toMatch(/^upload:avatar-\d+\.png$/);

    const settings = (await core.rpc.call('settings.get')) as Settings;
    expect(settings.userProfileAvatar).toBe(uploaded.avatar);

    const dir = path.join(home, 'user', 'avatar');
    const files = await readdir(dir);
    expect(files).toEqual([uploaded.avatar.slice('upload:'.length)]);
    expect(await readFile(path.join(dir, files[0]!))).toEqual(PNG_1PX);

    const data = (await core.rpc.call('user.avatar.data', {
      file: uploaded.avatar.slice('upload:'.length),
    })) as { mime: string; base64: string };
    expect(data.mime).toBe('image/png');
    expect(Buffer.from(data.base64, 'base64')).toEqual(PNG_1PX);
  });

  it('re-upload replaces the file and stale reads are rejected; SVG is not accepted', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-user-avatar-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      env: { KEPCUP_MOCK_LLM_URL: 'http://mock.invalid' },
    });
    cores.push(core);
    homes.push(home);

    const first = (await core.rpc.call('user.avatar.upload', {
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { avatar: string };
    const second = (await core.rpc.call('user.avatar.upload', {
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { avatar: string };
    expect(second.avatar).not.toBe(first.avatar);
    expect((await readdir(path.join(home, 'user', 'avatar')))).toHaveLength(1);
    await expect(
      core.rpc.call('user.avatar.data', { file: first.avatar.slice('upload:'.length) }),
    ).rejects.toThrow();
    await expect(
      core.rpc.call('user.avatar.upload', {
        mime: 'image/svg+xml',
        bytesBase64: PNG_1PX.toString('base64'),
      }),
    ).rejects.toThrow();
  });
});
