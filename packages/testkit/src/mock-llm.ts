import type { Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Scriptable OpenAI-compatible mock model service (docs/dev/05-testing.md).
 * Tests attach per-model step scripts; unmatched requests fail loudly so a
 * test can never pass by accident.
 */

export interface MockChatRequest {
  model: string;
  body: {
    model?: string;
    messages?: Array<{ role: string; content?: unknown }>;
    tools?: unknown[];
    stream?: boolean;
    [key: string]: unknown;
  };
  /** Concatenated text of the trailing user message. */
  lastUserText(): string;
}

export interface MockUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * D75: a request of a task execution (its user message carries the task
 * brief) — as opposed to a supervisor turn's.
 */
export function isTaskRequest(req: MockChatRequest): boolean {
  return JSON.stringify(req.body.messages ?? []).includes('<task_brief');
}

export interface MockLlmStep {
  /** Optional predicate; the step only matches requests passing it. */
  expect(check: (req: MockChatRequest) => boolean): MockLlmStep;
  /**
   * D75 lanes: the step only matches a supervisor turn's request (`inTurn`)
   * or a task's (`inTask`), on top of any `expect` predicate — turns and
   * tasks run concurrently on the same model, so their scripts interleave.
   */
  inTurn(): MockLlmStep;
  inTask(): MockLlmStep;
  replyText(text: string, usage?: MockUsage): MockLlmStep;
  /**
   * `args` may be a function `(req) => args`: it is evaluated when the
   * response is written (after a hold), for ids only known at run time.
   */
  replyToolCall(name: string, args: unknown, usage?: MockUsage): MockLlmStep;
  /**
   * One assistant turn carrying both prose and a tool call (finish_reason
   * tool_calls) — the interim-narration shape (todo/loop-interim-updates.md).
   */
  replyTextAndToolCall(text: string, name: string, args: unknown, usage?: MockUsage): MockLlmStep;
  /** Reply with a JSON payload as text (structured outputs in tests). */
  replyJson(payload: unknown, usage?: MockUsage): MockLlmStep;
  /**
   * Respond with an HTTP error (docs/dev/05-testing.md "错误注入"). The
   * response carries `x-should-retry: false` so the engine's model retry
   * (core agent/model-retry.ts) fails at once, as scripted; pass
   * `{ retryable: true }` (optionally with headers such as Retry-After) to
   * exercise the retry path instead.
   */
  failWith(
    status: number,
    message: string,
    options?: { retryable?: boolean; headers?: Record<string, string> },
  ): MockLlmStep;
  /** Suspend the response until `release()` is called. */
  hold(): MockLlmStep;
  release(): void;
  readonly consumed: boolean;
}

interface StepState {
  check?: (req: MockChatRequest) => boolean;
  /** The `expect` predicate alone (composed with `lane` into `check`). */
  userCheck?: (req: MockChatRequest) => boolean;
  /** D75 turn / task lane predicate. */
  lane?: (req: MockChatRequest) => boolean;
  kind?: 'text' | 'tool' | 'json' | 'fail';
  text?: string;
  /** Prose accompanying a tool-call reply (replyTextAndToolCall). */
  toolText?: string;
  toolName?: string;
  toolArgs?: unknown;
  usage?: MockUsage;
  failStatus?: number;
  failRetryable?: boolean;
  failHeaders?: Record<string, string>;
  hold?: boolean;
  claimed?: boolean;
  /** release() before the request arrived: skip the hold entirely. */
  released?: boolean;
  releaseResolvers: Array<() => void>;
}

class Step implements MockLlmStep {
  readonly state: StepState = { releaseResolvers: [] };

  get consumed(): boolean {
    return this.state.claimed === true;
  }

  expect(check: (req: MockChatRequest) => boolean): this {
    const lane = this.state.lane;
    this.state.check = lane === undefined ? check : (req) => lane(req) && check(req);
    this.state.userCheck = check;
    return this;
  }

  inTurn(): this {
    return this.#lane((req) => !isTaskRequest(req));
  }

  inTask(): this {
    return this.#lane(isTaskRequest);
  }

  #lane(lane: (req: MockChatRequest) => boolean): this {
    this.state.lane = lane;
    const user = this.state.userCheck;
    this.state.check = user === undefined ? lane : (req) => lane(req) && user(req);
    return this;
  }

  replyText(text: string, usage?: MockUsage): this {
    this.state.kind = 'text';
    this.state.text = text;
    this.state.usage = usage;
    return this;
  }

  replyToolCall(name: string, args: unknown, usage?: MockUsage): this {
    this.state.kind = 'tool';
    this.state.toolName = name;
    this.state.toolArgs = args;
    this.state.usage = usage;
    return this;
  }

  replyTextAndToolCall(text: string, name: string, args: unknown, usage?: MockUsage): this {
    this.replyToolCall(name, args, usage);
    this.state.toolText = text;
    return this;
  }

  replyJson(payload: unknown, usage?: MockUsage): this {
    return this.replyText(JSON.stringify(payload), usage);
  }

  failWith(
    status: number,
    message: string,
    options?: { retryable?: boolean; headers?: Record<string, string> },
  ): this {
    this.state.kind = 'fail';
    this.state.failStatus = status;
    this.state.failRetryable = options?.retryable === true;
    this.state.failHeaders = options?.headers;
    this.state.text = message;
    return this;
  }

  hold(): this {
    this.state.hold = true;
    return this;
  }

  release(): void {
    this.state.released = true;
    for (const resolve of this.state.releaseResolvers) resolve();
    this.state.releaseResolvers = [];
  }
}

export interface MockLlmServer {
  /** Base URL for OpenAI-compatible clients, e.g. http://127.0.0.1:53211/v1 */
  url: string;
  port: number;
  script(modelId: string, steps: Array<MockLlmStep>): void;
  requests(): MockChatRequest[];
  requestsFor(modelId: string): MockChatRequest[];
  /** True when the substring appeared in any serialized request body. */
  requestBodiesContain(substring: string): boolean;
  /** Releases every held step. */
  releaseAll(): void;
  /** Closes the server; open (held) request sockets are destroyed first. */
  stop(): Promise<void>;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

export const MOCK_EMBEDDING_DIM = 8;

/**
 * Deterministic mock embedding (testkit): character-hash bag-of-features,
 * unit-normalized. Exported so tests can compute the vector of a known text
 * and assert KNN results against the mock `/v1/embeddings` endpoint.
 */
export function mockEmbedding(text: string, dim = MOCK_EMBEDDING_DIM): Float32Array {
  const vector = new Float32Array(dim);
  for (let i = 0; i < text.length; i++) {
    const bucket = (text.charCodeAt(i) + i * 3) % dim;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) vector[i] = vector[i]! / norm;
  return vector;
}

export async function startMockLlm(): Promise<MockLlmServer> {
  const scripts = new Map<string, MockLlmStep[]>();
  const recordedRequests: MockChatRequest[] = [];
  const openSockets = new Set<Socket>();
  let server: Server | null = null;

  const respondCompletion = (
    res: ServerResponse,
    untypedStep: MockLlmStep,
    model: string,
    req: MockChatRequest,
  ) => {
    const step = untypedStep as Step;
    step.state.claimed = true; // one step serves exactly one request, held or not
    const finish = () => {
      if (step.state.kind === 'fail') {
        res.statusCode = step.state.failStatus ?? 500;
        res.setHeader('Content-Type', 'application/json');
        if (!step.state.failRetryable) res.setHeader('x-should-retry', 'false');
        for (const [name, value] of Object.entries(step.state.failHeaders ?? {})) {
          res.setHeader(name, value);
        }
        res.end(JSON.stringify({ error: { message: step.state.text ?? 'injected error' } }));
        return;
      }
      if (typeof step.state.toolArgs === 'function') {
        step.state.toolArgs = (step.state.toolArgs as (r: MockChatRequest) => unknown)(req);
      }
      writeCompletion(res, step, model, req.body.stream === true);
    };
    if (step.state.hold && !step.state.released) {
      step.state.releaseResolvers.push(() => finish());
      return;
    }
    finish();
  };

  server = createServer((req, res) => {
    req.socket.on('close', () => openSockets.delete(req.socket));
    openSockets.add(req.socket);
    // OpenAI-compatible embeddings endpoint (P07 vendor vector source):
    // deterministic vectors, no scripting needed.
    if (req.method === 'POST' && (req.url ?? '').endsWith('/embeddings')) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            model?: string;
            input?: string[] | string;
          };
          const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              object: 'list',
              model: body.model ?? 'mock-embed',
              data: inputs.map((text, index) => ({
                object: 'embedding',
                index,
                embedding: Array.from(mockEmbedding(String(text))),
              })),
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }),
          );
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        }
      });
      return;
    }
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `unexpected path ${req.url}` } }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: MockChatRequest['body'];
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }

      const model = String(body.model ?? '');
      const mockReq: MockChatRequest = {
        model,
        body,
        lastUserText() {
          const messages = body.messages ?? [];
          for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message && message.role === 'user') {
              return typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content);
            }
          }
          return '';
        },
      };
      recordedRequests.push(mockReq);

      const queue = scripts.get(model) as Step[] | undefined;
      const step = queue?.find((s) => !s.consumed && (!s.state.check || s.state.check(mockReq)));
      if (!step) {
        res.statusCode = 500;
        // Unscripted: fail loudly once, never retried into more misses.
        res.setHeader('x-should-retry', 'false');
        res.end(
          JSON.stringify({
            error: {
              message: `no scripted step available for model "${model}" (request recorded)`,
            },
          }),
        );
        return;
      }
      respondCompletion(res, step, model, mockReq);
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    script(modelId, steps) {
      scripts.set(modelId, [...steps]);
    },
    requests() {
      return [...recordedRequests];
    },
    requestsFor(modelId) {
      return recordedRequests.filter((r) => r.model === modelId);
    },
    requestBodiesContain(substring) {
      return recordedRequests.some((r) => JSON.stringify(r.body).includes(substring));
    },
    releaseAll() {
      for (const steps of scripts.values()) {
        for (const step of steps) step.release();
      }
    },
    async stop() {
      for (const socket of [...openSockets]) socket.destroy();
      openSockets.clear();
      await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server = null;
      });
    },
  };
}

function completionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2)}`;
}

function writeCompletion(res: ServerResponse, step: Step, model: string, stream: boolean): void {
  const usage = step.state.usage ?? { prompt_tokens: 10, completion_tokens: 5 };
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    let message: Record<string, unknown>;
    let finishReason: string;
    if (step.state.kind === 'tool') {
      message = {
        role: 'assistant',
        content: step.state.toolText ?? null,
        tool_calls: [
          {
            id: `call_${Math.random().toString(36).slice(2)}`,
            type: 'function',
            function: { name: step.state.toolName, arguments: JSON.stringify(step.state.toolArgs) },
          },
        ],
      };
      finishReason = 'tool_calls';
    } else {
      message = { role: 'assistant', content: step.state.text ?? '' };
      finishReason = 'stop';
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: completionId(),
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: {
          ...usage,
          total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        },
      }),
    );
    return;
  }

  res.statusCode = 200;
  res.writeHead(200, SSE_HEADERS);
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const id = completionId();
  const base = { id, object: 'chat.completion.chunk', created, model };

  if (step.state.kind === 'tool') {
    if (step.state.toolText !== undefined && step.state.toolText.length > 0) {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: step.state.toolText },
            finish_reason: null,
          },
        ],
      });
    }
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            ...(step.state.toolText === undefined ? { role: 'assistant' } : {}),
            tool_calls: [
              {
                index: 0,
                id: `call_x`,
                type: 'function',
                function: {
                  name: step.state.toolName,
                  arguments: JSON.stringify(step.state.toolArgs),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    send({
      ...base,
      choices: [{ index: 0, delta: { content: step.state.text ?? '' }, finish_reason: null }],
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  send({
    ...base,
    choices: [],
    usage: { ...usage, total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) },
  });
  res.end('data: [DONE]\n\n');
}

/** Convenience step builder matching docs/dev/05-testing.md examples. */
export function step(): MockLlmStep {
  return new Step();
}
