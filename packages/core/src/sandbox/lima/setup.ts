import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { limaInstanceYamlPath, limaSetupStatePath, sandboxLimaDir, resolveSandboxShimPath, type AppPaths } from '../../infra/paths.js';
import { LIMA_SHIM_BIN, LIMA_VM_NAME } from './constants.js';
import { limaInstanceState, parseLimaList } from './list.js';
import { buildProvisionScript, sandboxRuntimeVersion } from './provision.js';
import { buildLimaInstanceYaml } from './yaml.js';
import type { LimaRunResult, LimaRunner } from './runner.js';

/**
 * Lima 增强沙箱的准备状态机（设置页「沙箱准备向导」的 macOS 分支）。
 *
 *   idle → (用户点击创建) creating [limactl create，含镜像下载]
 *        → starting [limactl start]
 *        → provisioning [guest 内 apt + Node + srt + shim，幂等]
 *        → selfcheck → ready
 *        → failed（reason 可见，可重试）
 *
 * `prepare()` 立即返回当前状态并在后台推进（首次分钟级），向导轮询
 * `status()` 展示进度。所有 limactl 调用经注入的 LimaRunner，非 macOS 机器
 * 也能用 fixture 覆盖完整状态机。
 */

export type LimaSetupPhase = 'idle' | 'creating' | 'starting' | 'provisioning' | 'ready' | 'failed';

/** 向导应展示的主操作。 */
export type LimaSetupAction = 'create' | 'start' | 'provision' | 'retry' | 'wait' | 'none';

/** VM 实例状态（limactl list）。 */
export type LimaInstanceState = 'missing' | 'stopped' | 'running';

export interface LimaSetupSnapshot {
  phase: LimaSetupPhase;
  /** Set when the phase is failed. */
  reason?: string;
  /** Latest progress line (display only). */
  progress?: string;
  updatedAt: number;
}

export interface LimaStatusReport {
  phase: LimaSetupPhase;
  instance: LimaInstanceState;
  action: LimaSetupAction;
  reason?: string;
  fixHint?: string;
  progress?: string;
}

export class LimaSetup {
  readonly #paths: AppPaths;
  readonly #runner: LimaRunner;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #shimPath: string | null;
  readonly #nodeVersion: string | undefined;
  readonly #srtVersion: string;
  #snapshot: LimaSetupSnapshot | null;
  #active: Promise<void> | null = null;
  #lastPersist = 0;

  constructor(input: {
    paths: AppPaths;
    runner: LimaRunner;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    /** Test seam: explicit shim path (default: resolveSandboxShimPath(env)). */
    shimPath?: string;
    nodeVersion?: string;
    srtVersion?: string;
  }) {
    this.#paths = input.paths;
    this.#runner = input.runner;
    this.#now = input.now ?? Date.now;
    this.#env = input.env ?? process.env;
    this.#shimPath = input.shimPath ?? resolveSandboxShimPath(this.#env);
    this.#nodeVersion = input.nodeVersion;
    this.#srtVersion = input.srtVersion ?? sandboxRuntimeVersion();
    this.#snapshot = this.#loadSnapshot();
  }

  snapshot(): LimaSetupSnapshot | null {
    return this.#snapshot;
  }

  /** True while a create/start/provision pass is running. */
  get busy(): boolean {
    return this.#active !== null;
  }

  async status(): Promise<LimaStatusReport> {
    const detection = await this.#detect();
    const instance = detection.state;
    const snapshot = this.#snapshot;
    const active = this.#active !== null;
    let phase: LimaSetupPhase = snapshot?.phase ?? 'idle';

    // A persisted in-progress phase with no live run means the app exited (or
    // the core crashed) mid-pass — surface it as a retryable failure instead of
    // a progress state that never finishes.
    if (!active && (phase === 'creating' || phase === 'starting' || phase === 'provisioning')) {
      phase = 'failed';
    }

    if (active) {
      return {
        phase,
        instance,
        action: 'wait',
        ...(snapshot?.progress !== undefined ? { progress: snapshot.progress } : {}),
      };
    }

    if (detection.error !== undefined) {
      return {
        phase: 'failed',
        instance,
        action: 'retry',
        reason: `无法读取 Lima 实例列表：${detection.error}`,
        fixHint: '确认 Lima 已安装（brew install lima）后重试',
      };
    }

    if (phase === 'failed') {
      return {
        phase,
        instance,
        action: 'retry',
        reason: snapshot?.reason ?? '上次准备未完成，请重试',
      };
    }

    if (instance === 'running' && phase === 'ready') {
      return { phase: 'ready', instance, action: 'none' };
    }
    if (instance === 'missing') {
      return {
        phase: 'idle',
        instance,
        action: 'create',
        reason: '增强沙箱虚拟机尚未创建',
        fixHint: '首次创建会下载 Debian 12 镜像并在虚拟机内安装沙箱工具（约 1GB，需要联网，数分钟）',
      };
    }
    if (instance === 'stopped') {
      return {
        phase: 'idle',
        instance,
        action: 'start',
        reason: '增强沙箱虚拟机未在运行',
        fixHint: '启动虚拟机后即可使用增强沙箱',
      };
    }
    return {
      phase: 'idle',
      instance,
      action: 'provision',
      reason: '增强沙箱虚拟机已运行，但沙箱工具尚未初始化',
      fixHint: '初始化沙箱工具（Node 与 sandbox-runtime）后即可使用增强沙箱',
    };
  }

  /**
   * 启动准备流程。默认立即返回当前状态（RPC 不挂住分钟级操作），
   * `wait: true` 供测试/命令行等待完成。
   */
  async prepare(options: { wait?: boolean } = {}): Promise<LimaStatusReport> {
    if (this.#active === null) {
      // `.finally` 的回调是微任务：即使 #run 在首个 await 前就失败，赋值也
      // 先发生、随后才清空，不会把已完成的 promise 永久留在 #active 里。
      const run = this.#run().finally(() => {
        this.#active = null;
      });
      this.#active = run;
    }
    if (options.wait === true) await this.#active;
    return this.status();
  }

  // --- internals ---------------------------------------------------------------

  async #run(): Promise<void> {
    try {
      if (this.#shimPath === null || !existsSync(this.#shimPath)) {
        throw new Error('缺少沙箱 shim 资源（kepcup-sandbox.cjs），安装包不完整');
      }
      let detection = await this.#detect();
      if (detection.error !== undefined) {
        throw new Error(`无法读取 Lima 实例列表：${detection.error}`);
      }

      if (detection.state === 'missing') {
        this.#persist({
          phase: 'creating',
          progress: '正在创建虚拟机（下载 Debian 12 镜像）…',
          updatedAt: this.#now(),
        });
        mkdirSync(sandboxLimaDir(this.#paths), { recursive: true });
        const yamlPath = limaInstanceYamlPath(this.#paths);
        writeFileSync(yamlPath, buildLimaInstanceYaml(), 'utf8');
        const created = await this.#runner.run(
          ['create', '--tty=false', '--name', LIMA_VM_NAME, yamlPath],
          { timeoutMs: 60 * 60_000, onOutput: this.#onOutput },
        );
        this.#ensureOk('创建虚拟机', created);
        detection = await this.#detect();
      }

      if (detection.state !== 'running') {
        this.#persist({
          phase: 'starting',
          progress: '正在启动虚拟机…',
          updatedAt: this.#now(),
        });
        const started = await this.#runner.run(['start', '--tty=false', LIMA_VM_NAME], {
          timeoutMs: 20 * 60_000,
          onOutput: this.#onOutput,
        });
        this.#ensureOk('启动虚拟机', started);
      }

      this.#persist({
        phase: 'provisioning',
        progress: '正在初始化沙箱工具…',
        updatedAt: this.#now(),
      });
      const script = buildProvisionScript({
        ...(this.#nodeVersion !== undefined ? { nodeVersion: this.#nodeVersion } : {}),
        srtVersion: this.#srtVersion,
        shimBase64: readFileSync(this.#shimPath).toString('base64'),
      });
      const provisioned = await this.#runner.run(
        ['shell', '--tty=false', LIMA_VM_NAME, '--', 'bash', '-s'],
        { input: script, timeoutMs: 45 * 60_000, onOutput: this.#onOutput },
      );
      this.#ensureOk('初始化沙箱工具', provisioned);

      const selfcheck = await this.#runner.run(
        ['shell', '--tty=false', LIMA_VM_NAME, '--', LIMA_SHIM_BIN, '--selfcheck'],
        { timeoutMs: 3 * 60_000 },
      );
      this.#ensureOk('沙箱自检', selfcheck);

      this.#persist({ phase: 'ready', updatedAt: this.#now() });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#persist({ phase: 'failed', reason, updatedAt: this.#now() });
    }
  }

  async #detect(): Promise<{ state: LimaInstanceState; error?: string }> {
    const result = await this.#runner.run(['list', '--json'], { timeoutMs: 15_000 });
    if (result.error !== undefined) return { state: 'missing', error: result.error };
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString('utf8').trim();
      return { state: 'missing', error: detail.length > 0 ? detail : `退出码 ${result.exitCode}` };
    }
    return { state: limaInstanceState(parseLimaList(result.stdout.toString('utf8'))) };
  }

  #ensureOk(label: string, result: LimaRunResult): void {
    if (result.error !== undefined) throw new Error(`${label}失败：${result.error}`);
    if (result.exitCode === 0) return;
    const lastLine = (text: string): string => {
      const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return lines[lines.length - 1] ?? '';
    };
    const stderr = lastLine(result.stderr.toString('utf8'));
    const stdout = lastLine(result.stdout.toString('utf8'));
    const raw = stderr.length > 0 ? stderr : stdout.length > 0 ? stdout : `退出码 ${result.exitCode}`;
    const detail = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
    throw new Error(`${label}失败：${detail}`);
  }

  /** Keeps the last meaningful output line as the wizard progress text. */
  #onOutput = (_stream: 'stdout' | 'stderr', text: string): void => {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const raw = lines[lines.length - 1];
    if (raw === undefined) return;
    // limactl 日志行：time="…" level=info msg="…" —— 只保留 msg 给界面。
    const last = raw.replace(/^time="[^"]*" level=\w+ msg="(.*)"$/, '$1');
    if (this.#snapshot !== null && this.#snapshot.progress === last) return;
    const phase = this.#snapshot?.phase ?? 'idle';
    if (phase === 'ready' || phase === 'failed') return;
    const now = this.#now();
    const progress = last.length > 200 ? `${last.slice(0, 200)}…` : last;
    this.#snapshot = { phase, progress, updatedAt: now };
    // Output can be chatty; persistence is only for restart recovery.
    if (now - this.#lastPersist < 1_000) return;
    this.#lastPersist = now;
    this.#writeSnapshot();
  };

  // --- persistence ---------------------------------------------------------------

  #loadSnapshot(): LimaSetupSnapshot | null {
    const file = limaSetupStatePath(this.#paths);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        phase?: string;
        reason?: string;
        progress?: string;
        updatedAt?: number;
      };
      if (typeof parsed.phase !== 'string') return null;
      return {
        phase: parsed.phase as LimaSetupPhase,
        ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
        ...(typeof parsed.progress === 'string' ? { progress: parsed.progress } : {}),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      };
    } catch {
      return null;
    }
  }

  #persist(snapshot: LimaSetupSnapshot): void {
    this.#snapshot = snapshot;
    this.#writeSnapshot();
  }

  #writeSnapshot(): void {
    if (this.#snapshot === null) return;
    try {
      mkdirSync(sandboxLimaDir(this.#paths), { recursive: true });
      writeFileSync(limaSetupStatePath(this.#paths), JSON.stringify(this.#snapshot), 'utf8');
    } catch {
      // Best-effort: the state machine re-derives from limactl on the next
      // status() even without the persisted file.
    }
  }
}
