/** Sandbox interfaces (docs/dev/02-architecture.md "沙箱"). srt details stay
 * inside backend-srt.ts; other modules must not import srt directly. All
 * wsl.exe details stay inside sandbox/wsl/ (docs/dev/phases/P12 任务书注意
 * 事项); backend-wsl.ts and the container backends only see those modules. */

export type SandboxBackendKind = 'srt' | 'wsl' | 'lima' | 'podman' | 'none';

export interface SandboxAvailability {
  backend: SandboxBackendKind;
  available: boolean;
  /** Localized reason when unavailable. */
  reason?: string;
  /** Localized repair hint, e.g. a sudo command to run. */
  fixHint?: string;
}

export type NetworkMode = 'none' | 'allowlist' | 'open';

export interface SandboxNetworkPolicy {
  mode: NetworkMode;
  /** Domains reachable in `allowlist` mode; ignored otherwise. */
  allowDomains: string[];
  /**
   * Conversation bound to a project: the sandbox may listen on and reach
   * localhost ports (dev servers, docs/design/10-sandbox.md "网络").
   */
  allowLocalhost?: boolean;
  /** Inclusive port ranges reachable on localhost; undefined = unrestricted. */
  allowedPorts?: Array<[number, number]>;
}

export interface SandboxPolicy {
  /** Readable and writable directories (workspace, app caches, temp). */
  readWrite: string[];
  /** Read-only directories (system + toolchain). */
  readOnly: string[];
  /** Never readable (data home, sensitive locations). */
  denyRead: string[];
  network: SandboxNetworkPolicy;
  /** Environment for the sandboxed command (cache dirs etc.). */
  env: Record<string, string>;
}

export interface SandboxExecRequest {
  command: string;
  cwd: string;
  policy: SandboxPolicy;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Merged stdout/stderr streaming for progress display. */
  onOutput?: (chunk: string) => void;
}

export interface SandboxViolation {
  line: string;
  command?: string;
}

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the command was killed after timeoutMs. */
  timedOut: boolean;
  violations: SandboxViolation[];
}

export interface SandboxBackend {
  kind: SandboxBackendKind;
  /** `force` re-runs the detection instead of returning the cached verdict. */
  probe(force?: boolean): Promise<SandboxAvailability>;
  exec(req: SandboxExecRequest): Promise<SandboxExecResult>;
}

/** Backend that never runs anything (unsupported platform / disabled). */
export class UnavailableSandboxBackend implements SandboxBackend {
  readonly kind: SandboxBackendKind = 'none';
  readonly #availability: SandboxAvailability;

  constructor(reason: string) {
    this.#availability = { backend: 'none', available: false, reason };
  }

  probe(): Promise<SandboxAvailability> {
    return Promise.resolve(this.#availability);
  }

  exec(): Promise<SandboxExecResult> {
    return Promise.reject(new Error('SANDBOX_UNAVAILABLE'));
  }
}
