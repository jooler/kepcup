import {
  getWebTransport,
  parsePairingLink,
  type PairingLink,
  type PairingPhase,
  type WebLinkState,
  type WsTransport,
} from '$lib/rpc/ws-transport';
import { ENDPOINT_KIND, defaultDeviceName } from './endpoint';

/**
 * WebShellGate 的响应式状态（web 构建 = 手机 PWA 的「门」）：把 WsTransport 的
 * 连接状态（粗）与配对阶段（细）镜像成 runes 状态，供 Gate 按状态机渲染——
 * 未配对（粘贴配对链接）→ 确认设备名 → 连接中转/配对中 → 等待桌面确认 →
 * 已连接（渲染正常 App UI）/ 被拒 / 被撤销 / 桌面离线 / 断线重连。
 *
 * Electron 路径（ENDPOINT_KIND === 'desktop'）恒 connected 且不订阅任何东西：
 * Gate 在桌面只是把 children 原样渲染出来，零行为变化。
 */

export type GateView =
  | 'unpaired'
  | 'enter-name'
  | 'joining'
  | 'awaiting-confirm'
  | 'booting'
  | 'connected'
  | 'rejected'
  | 'kicked'
  | 'failed'
  | 'offline'
  | 'disconnected';

export type RejectReason = 'expired' | 'declined' | 'bad_code' | 'busy' | 'error';

/** beforeinstallprompt 事件的最小形状（Chromium 安装引导；捕获后由 Gate 出按钮）。 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

class WebGateState {
  view = $state<GateView>('unpaired');
  /** 配对链接输入框内容（也承接 #pair=… 深链的预填）。 */
  linkInput = $state('');
  inputError = $state<string | null>(null);
  /** 已解析待确认的链接（enter-name 步骤展示中转地址用）。 */
  pendingLink = $state<PairingLink | null>(null);
  deviceName = $state(defaultDeviceName());
  rejectReason = $state<RejectReason>('error');
  kickReason = $state<'revoked' | 'auth_failed'>('revoked');
  installAvailable = $state(false);
  /** 已配对设备的密钥指纹（连接页展示，帮助用户核对连到的是哪台桌面）。 */
  keyFingerprint = $state('');

  #transport: WsTransport | null = null;
  #installEvent: InstallPromptEvent | null = null;

  constructor() {
    if (ENDPOINT_KIND !== 'remote') {
      this.view = 'connected';
      return;
    }
    const transport = getWebTransport();
    this.#transport = transport;
    this.keyFingerprint = transport.keyFingerprint;
    transport.onLinkState((state) => {
      this.#sync(state, transport.pairing);
    });
    transport.onPairing((phase) => {
      this.#sync(transport.linkState, phase);
    });
    this.#sync(transport.linkState, transport.pairing);
    // 带着凭证冷启动：让 transport 自动重连自举（CoreConnection 不负责这件事）。
    if (transport.hasCredentials()) transport.resume();
    this.#captureHashPairLink();
  }

  #sync(link: WebLinkState, pairing: PairingPhase): void {
    if (pairing.kind === 'rejected') this.rejectReason = pairing.reason;
    if (pairing.kind === 'kicked') this.kickReason = pairing.reason;
    if (pairing.kind === 'connected' || link === 'connected') {
      this.view = 'connected';
      this.pendingLink = null;
      this.keyFingerprint = this.#transport?.keyFingerprint ?? '';
      return;
    }
    if (pairing.kind === 'joining' || pairing.kind === 'awaiting-confirm') {
      this.view = pairing.kind;
      return;
    }
    if (pairing.kind === 'rejected') {
      this.view = 'rejected';
      return;
    }
    if (pairing.kind === 'failed') {
      this.view = 'failed';
      return;
    }
    if (pairing.kind === 'kicked') {
      this.view = 'kicked';
      return;
    }
    // pairing === 'idle'：没有进行中的配对流程，看连接状态（可能带着凭证）。
    if (this.pendingLink !== null) {
      this.view = 'enter-name';
      return;
    }
    if (this.#transport?.hasCredentials() === true) {
      this.view =
        link === 'offline' ? 'offline' : link === 'reconnecting' ? 'disconnected' : 'booting';
      return;
    }
    this.view = 'unpaired';
  }

  /** 进 入-name 步骤：解析输入框里的链接（二维码扫描器通常给出整条 URL）。 */
  submitLink(): void {
    if (this.#transport === null) return;
    const link = parsePairingLink(this.linkInput);
    if (link === null) {
      this.inputError = 'invalid';
      return;
    }
    this.inputError = null;
    this.pendingLink = link;
    this.view = 'enter-name';
  }

  /** enter-name → 发起配对（pairing.request 携带确认过的设备名）。 */
  submitDeviceName(): void {
    if (this.#transport === null || this.pendingLink === null) return;
    // 防抖（真机反馈：连点产生多张确认卡）：进入配对流程后忽略重复提交；
    // 传输层还有同会话幂等兜底（startPairing）。
    if (this.view === 'joining' || this.view === 'awaiting-confirm') return;
    const name = this.deviceName.trim().slice(0, 60) || defaultDeviceName();
    this.deviceName = name;
    const link = this.pendingLink;
    this.pendingLink = null;
    this.view = 'joining';
    void this.#transport.startPairing(link, name);
    // 配对开始即清掉深链：刷新页面不再自动回到配对（凭证建立后走重连）。
    history.replaceState(null, '', location.pathname + location.search);
  }

  /**
   * 页内扫码成功的入口（相机与解码循环在 Gate 组件里）：解析二维码文本并直接进
   * 设备名步骤。手机系统相机扫码后一关浏览器地址就找不回来了（尤其微信内置浏览器），
   * 页内扫码让链接全程不离开本页。解析失败返回 false（组件显示错误并继续扫）。
   */
  acceptScannedCode(raw: string): boolean {
    const link = parsePairingLink(raw);
    if (link === null) return false;
    this.linkInput = raw;
    this.inputError = null;
    this.pendingLink = link;
    this.view = 'enter-name';
    return true;
  }

  /** enter-name 返回粘贴步（链接写错了等）。 */
  backToUnpaired(): void {
    this.pendingLink = null;
    this.inputError = null;
    this.view = 'unpaired';
  }

  /** 离线 / 断线页的手动重试。 */
  retryConnection(): void {
    this.#transport?.reconnect();
  }

  /** 被撤销 / 认证失败 / 重新配对：清本地凭证回配对态。 */
  resetPairing(): void {
    this.linkInput = '';
    this.inputError = null;
    this.keyFingerprint = '';
    this.#transport?.resetPairing();
  }

  // --- 安装引导（web-main.ts 捕获 beforeinstallprompt 后转交这里）-----------------

  captureInstallPrompt(event: Event): void {
    this.#installEvent = event as InstallPromptEvent;
    this.installAvailable = true;
  }

  async promptInstall(): Promise<void> {
    const event = this.#installEvent;
    if (event === null) return;
    this.#installEvent = null;
    this.installAvailable = false;
    await event.prompt().catch(() => {});
  }

  /** appinstalled（用户完成安装）后收起引导。 */
  markInstalled(): void {
    this.#installEvent = null;
    this.installAvailable = false;
  }

  /** 首次加载若 hash 里带着配对链接（扫码直达），预填并直接进设备名步骤。 */
  #captureHashPairLink(): void {
    if (!location.hash.startsWith('#pair=')) return;
    const link = parsePairingLink(location.hash);
    if (link === null) return;
    this.linkInput = location.hash;
    this.pendingLink = link;
    this.view = 'enter-name';
  }
}

export const webGate = new WebGateState();
