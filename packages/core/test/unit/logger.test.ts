import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  createValueRedactor,
  redactRecord,
  REDACTED,
} from '../../src/infra/logger.js';

const tempDirs: string[] = [];

function tempLogsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'logger-test-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function readLogText(dir: string): Promise<string> {
  const logsDir = path.join(dir, 'logs');
  const files = readdirSync(logsDir).filter((f) => f.startsWith('kepcup'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return files.map((f) => readFileSync(path.join(logsDir, f), 'utf8')).join('\n');
}

describe('redactRecord', () => {
  it('redacts sensitive keys at any depth', () => {
    const redacted = redactRecord({
      apiKey: 'sk-abc',
      nested: { api_key: 'x', token: 'y', Authorization: 'Bearer z', cookie: 'c' },
      list: [{ password: 'p' }],
      normal: 'kept',
    });
    expect(redacted.apiKey).toBe(REDACTED);
    expect(redacted.nested.api_key).toBe(REDACTED);
    expect(redacted.nested.token).toBe(REDACTED);
    expect(redacted.nested.Authorization).toBe(REDACTED);
    expect(redacted.nested.cookie).toBe(REDACTED);
    expect(redacted.list[0]?.password).toBe(REDACTED);
    expect(redacted.normal).toBe('kept');
  });

  it('redacts via the value redactor', () => {
    const redact = createValueRedactor(['sk-live-123']);
    expect(redact('call to sk-live-123 failed')).toBe(`call to ${REDACTED} failed`);
    expect(redact('nothing here')).toBe('nothing here');
  });
});

describe('createLogger', () => {
  it('writes redacted records to the rotating log file', async () => {
    const dir = tempLogsDir();
    const logger = await createLogger({ logsDir: path.join(dir, 'logs') });
    logger.info({ apiKey: 'sk-file-secret', plain: 'visible' }, 'hello');
    logger.child({ token: 'tok-123' }).info('child message');
    await logger.close();
    const text = await readLogText(dir);
    expect(text).toContain('hello');
    expect(text).toContain('visible');
    expect(text).not.toContain('sk-file-secret');
    expect(text).not.toContain('tok-123');
    expect(text).toContain(REDACTED);
  });
});
