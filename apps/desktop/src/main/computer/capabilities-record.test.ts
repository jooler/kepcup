import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capabilitiesRecordFile,
  readCapabilitiesRecord,
  writeCapabilitiesRecord,
} from './capabilities-record';

describe('capabilities-record', () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'kepcup-capabilities-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('round-trips a record', () => {
    const record = { available: false, error: 'helper spawn failed', checkedAt: 1760000000000 };
    writeCapabilitiesRecord(userDataDir, record);
    expect(readCapabilitiesRecord(userDataDir)).toEqual(record);
    expect(capabilitiesRecordFile(userDataDir)).toContain('computer-use-capabilities.json');
  });

  it('returns null for a missing or corrupt record', () => {
    expect(readCapabilitiesRecord(userDataDir)).toBeNull();
    writeFileSync(capabilitiesRecordFile(userDataDir), '{not json');
    expect(readCapabilitiesRecord(userDataDir)).toBeNull();
  });

  it('returns null when fields do not match the record shape', () => {
    writeFileSync(capabilitiesRecordFile(userDataDir), JSON.stringify({ available: 'yes' }));
    expect(readCapabilitiesRecord(userDataDir)).toBeNull();
  });

  it('never throws when the target directory cannot be created', () => {
    // userDataDir 指向一个文件：mkdir / write 失败 → 静默（诊断落盘尽力而为）。
    const blocked = join(userDataDir, 'blocked');
    writeFileSync(blocked, 'x');
    expect(() =>
      writeCapabilitiesRecord(blocked, { available: true, error: null, checkedAt: 1 }),
    ).not.toThrow();
  });
});
