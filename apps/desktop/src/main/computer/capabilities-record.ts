import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * D105 capabilities 握手结果的落盘记录（2026-10-31 冒烟反馈）：握手失败此前只进
 * dev 主进程 stdout，无终端就无从定位「工具为什么没注册」。编排层每次握手（成功
 * 或失败）都把结果写到 `userData/computer-use-capabilities.json`——设置页的可用性
 * 状态（`computer:capabilities-status`）从这里取失败原因，下次握手覆盖。
 * 纯 node fs，路径由调用方注入（main 装配时给 `app.getPath('userData')`），
 * 模块自身不 import electron，保持可单测。
 */

export interface ComputerCapabilitiesRecord {
  available: boolean;
  /** available=false 时的握手失败原因（sidecar 缺失 / helper 拉起失败等，原样人类可读）。 */
  error: string | null;
  /** 本次检查的毫秒时间戳。 */
  checkedAt: number;
}

export const CAPABILITIES_RECORD_FILENAME = 'computer-use-capabilities.json';

export function capabilitiesRecordFile(userDataDir: string): string {
  return join(userDataDir, CAPABILITIES_RECORD_FILENAME);
}

/** 读上次握手记录；文件缺失 / 损坏 / 字段不合返回 null（诊断信息尽力而为）。 */
export function readCapabilitiesRecord(userDataDir: string): ComputerCapabilitiesRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(capabilitiesRecordFile(userDataDir), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const { available, error, checkedAt } = raw as Record<string, unknown>;
    if (typeof available !== 'boolean' || typeof checkedAt !== 'number') return null;
    if (error !== null && typeof error !== 'string') return null;
    return { available, error, checkedAt };
  } catch {
    return null;
  }
}

/** 写本次握手记录；写失败静默（不能让诊断落盘影响握手本身）。 */
export function writeCapabilitiesRecord(
  userDataDir: string,
  record: ComputerCapabilitiesRecord,
): void {
  try {
    const file = capabilitiesRecordFile(userDataDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record));
  } catch {
    // best effort
  }
}
