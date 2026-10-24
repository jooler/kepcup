import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from '../infra/fs-rm.js';
import path from 'node:path';
import { AppError } from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import type { Clock } from '../infra/clock.js';
import type { SettingsService } from './settings.js';

const MAX_AVATAR_BYTES = 3_000_000;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** Plain file-name characters only — blocks path traversal into the data home. */
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 用户个人资料头像（设置页「个人资料」）：`{home}/user/avatar/` 下只保留最新一张，
 * `settings.userProfileAvatar` 存 `upload:{fileName}`（'' = 未设置）。写入设置行与
 * 发布 `settings.changed` 由 RPC 绑定层负责（同一把设置写锁），这里只管文件。
 */
export class UserProfileAvatarService {
  constructor(
    private readonly deps: { paths: AppPaths; clock: Clock; settings: SettingsService },
  ) {}

  #avatarDir(): string {
    return path.join(this.deps.paths.home, 'user', 'avatar');
  }

  /** 当前头像引用（settings.userProfileAvatar）。 */
  avatarRef(): string {
    return this.deps.settings.get().userProfileAvatar;
  }

  /** 落盘新头像并更新 `userProfileAvatar`；返回新的头像引用。调用方需持有设置写锁。 */
  upload(mime: string, bytes: Buffer): string {
    const ext = EXT_BY_MIME[mime];
    if (!ext) throw new AppError('INVALID_INPUT', `Unsupported avatar mime: ${mime}`);
    if (bytes.byteLength === 0) throw new AppError('INVALID_INPUT', 'Avatar file is empty');
    if (bytes.byteLength > MAX_AVATAR_BYTES) {
      throw new AppError('INVALID_INPUT', 'Avatar file is too large (max 3 MB)');
    }
    const dir = this.#avatarDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `avatar-${this.deps.clock.now()}${ext}`;
    writeFileSync(path.join(dir, fileName), bytes);
    // 只保留当前一张：渲染层按文件名缓存 dataURL，旧文件的在途读取已解析完毕。
    for (const entry of readdirSync(dir)) {
      if (entry !== fileName) rmSync(path.join(dir, entry), { force: true });
    }
    const ref = `upload:${fileName}`;
    this.deps.settings.update({ userProfileAvatar: ref });
    return ref;
  }

  read(file: string): { mime: string; base64: string } {
    if (!FILE_NAME_RE.test(file) || file.includes('..')) {
      throw new AppError('INVALID_INPUT', 'Invalid avatar file name');
    }
    const previous = this.avatarRef();
    if (previous !== `upload:${file}`) {
      throw new AppError('NOT_FOUND', `Avatar ${file} is not the current user avatar`);
    }
    try {
      const bytes = readFileSync(path.join(this.#avatarDir(), file));
      const mime = Object.entries(EXT_BY_MIME).find(([, ext]) => file.endsWith(ext))?.[0];
      if (!mime) throw new Error('unknown extension');
      return { mime, base64: bytes.toString('base64') };
    } catch {
      throw new AppError('NOT_FOUND', `Avatar ${file} does not exist`);
    }
  }
}
