import type * as BarcodeScannerModule from '@capacitor/barcode-scanner';

/**
 * 原生扫码包装(D122 §1.4):官方 @capacitor/barcode-scanner——同时带 Package.swift
 * 与 podspec,iOS 的 SPM 工程可直接集成(MLKit 独立插件只有 podspec,iOS SPM 不兼
 * 容,2026-11-11 择优换用);Android 走 ML Kit 引擎(scanningLibrary)。权限由插件
 * 内部申请;相机用途文案在 Info.plist / AndroidManifest。动态 import +
 * `isNativePlatform` 前置守卫:纯浏览器 dev(无原生桥)直接报 unsupported,UI 据
 * 此提示改用手动输入。
 */

export type ScanFailure = 'unsupported' | 'denied' | 'cancelled' | 'failed';

export type ScanResult = { ok: true; text: string } | { ok: false; reason: ScanFailure };

const zhUI = navigator.language.startsWith('zh');

export async function scanOnce(): Promise<ScanResult> {
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return { ok: false, reason: 'unsupported' };
  let scanner: typeof BarcodeScannerModule;
  try {
    scanner = await import('@capacitor/barcode-scanner');
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
  const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = scanner;
  try {
    const { ScanResult: text } = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: zhUI ? '对准二维码即可自动识别' : 'Point the camera at a QR code',
      android: { scanningLibrary: scanner.CapacitorBarcodeScannerAndroidScanningLibrary.MLKIT },
    });
    // 插件契约:用户取消时 ScanResult 为空串。
    if (text.length === 0) return { ok: false, reason: 'cancelled' };
    return { ok: true, text };
  } catch (error) {
    // 权限拒绝在 Android 上表现为 SecurityException 文案;iOS 相机被拒走 error 路径。
    const message = (error as { message?: string } | null)?.message ?? '';
    if (/authoriz|permission|denied/i.test(message)) return { ok: false, reason: 'denied' };
    return { ok: false, reason: 'failed' };
  }
}

/**
 * 服务地址连通性预检(D122 §3):`no-cors` fetch——服务有任何 HTTP 响应即 resolve
 * (opaque,不需要 CORS 头);网络不可达 / 端口不通才 reject。只做「通不通」的
 * 提示,不拦连接(headless 可能就是离线状态,用户可选择强行连)。
 */
export async function probeReachable(url: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
