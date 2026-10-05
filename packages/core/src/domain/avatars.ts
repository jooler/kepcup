import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, type Bot } from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import type { Clock } from '../infra/clock.js';
import type { BotsService } from './bots.js';

const MAX_AVATAR_BYTES = 3_000_000;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** Plain file-name characters only — blocks path traversal into the data home. */
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Uploaded bot avatars: `{home}/bots/{id}/avatar/` (bot deletion already
 * removes the whole `bots/{id}/` directory, so no extra cleanup hook).
 * `identity.avatar` stores `upload:{fileName}` for uploaded images;
 * `preset:{shape}:{color}` values never touch the disk here.
 */
export class BotAvatarService {
  constructor(
    private readonly deps: { paths: AppPaths; clock: Clock; bots: BotsService },
  ) {}

  #avatarDir(botId: string): string {
    return path.join(this.deps.paths.home, 'bots', botId, 'avatar');
  }

  upload(botId: string, mime: string, bytes: Buffer): Bot {
    const ext = EXT_BY_MIME[mime];
    if (!ext) throw new AppError('INVALID_INPUT', `Unsupported avatar mime: ${mime}`);
    if (bytes.byteLength === 0) throw new AppError('INVALID_INPUT', 'Avatar file is empty');
    if (bytes.byteLength > MAX_AVATAR_BYTES) {
      throw new AppError('INVALID_INPUT', 'Avatar file is too large (max 3 MB)');
    }
    const bot = this.deps.bots.getOrThrow(botId);
    if (bot.status !== 'active') {
      throw new AppError('CONVERSATION_READ_ONLY', `Bot ${botId} has been deleted`);
    }
    const dir = this.#avatarDir(botId);
    mkdirSync(dir, { recursive: true });
    const fileName = `avatar-${this.deps.clock.now()}${ext}`;
    writeFileSync(path.join(dir, fileName), bytes);
    // One avatar slot per bot: drop earlier uploads so the directory stays
    // bounded (the renderer caches by file name, so in-flight readers of the
    // old file have already resolved their bytes).
    for (const entry of readdirSync(dir)) {
      if (entry !== fileName) rmSync(path.join(dir, entry), { force: true });
    }
    // setAvatar（非 update）：访谈期间上传头像不得提前改写 bots.name。
    return this.deps.bots.setAvatar(botId, `upload:${fileName}`);
  }

  read(botId: string, file: string): { mime: string; base64: string } {
    if (!FILE_NAME_RE.test(file) || file.includes('..')) {
      throw new AppError('INVALID_INPUT', 'Invalid avatar file name');
    }
    const previous = this.deps.bots.get(botId)?.avatar ?? null;
    if (previous !== `upload:${file}`) {
      throw new AppError('NOT_FOUND', `Avatar ${file} is not current for bot ${botId}`);
    }
    try {
      const bytes = readFileSync(path.join(this.#avatarDir(botId), file));
      const mime = Object.entries(EXT_BY_MIME).find(([, ext]) => file.endsWith(ext))?.[0];
      if (!mime) throw new Error('unknown extension');
      return { mime, base64: bytes.toString('base64') };
    } catch {
      throw new AppError('NOT_FOUND', `Avatar ${file} does not exist for bot ${botId}`);
    }
  }
}
