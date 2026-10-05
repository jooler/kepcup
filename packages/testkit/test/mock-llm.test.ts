import { afterEach, describe, expect, it } from 'vitest';
import { startMockLlm, step, type MockLlmServer } from '../src/mock-llm.js';

const servers: MockLlmServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function start() {
  const server = await startMockLlm();
  servers.push(server);
  return server;
}

const completionRequest = (model: string, text: string, stream = false) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    stream,
    messages: [
      { role: 'system', content: 'you are a bot' },
      { role: 'user', content: text },
    ],
  }),
});

describe('mock LLM service', () => {
  it('starts, serves a scripted text reply and records the request', async () => {
    const llm = await start();
    llm.script('mock-main', [step().replyText('完成了')]);

    const res = await fetch(
      `${llm.url}/chat/completions`,
      completionRequest('mock-main', '帮我做件事'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(body.choices[0]?.message.content).toBe('完成了');
    expect(body.choices[0]?.finish_reason).toBe('stop');

    expect(llm.requests()).toHaveLength(1);
    expect(llm.requestsFor('mock-main')[0]?.lastUserText()).toContain('帮我做件事');
  });

  it('serves scripted tool-call replies with SSE streaming', async () => {
    const llm = await start();
    llm.script('mock-main', [step().replyToolCall('send_message', { text: '收到' })]);

    const res = await fetch(
      `${llm.url}/chat/completions`,
      completionRequest('mock-main', '回复我', true),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('send_message');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text.trim().endsWith('[DONE]')).toBe(true);
  });

  it('fails loudly on unscripted models', async () => {
    const llm = await start();
    const res = await fetch(`${llm.url}/chat/completions`, completionRequest('unknown', 'hi'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('no scripted step');
  });

  it('fails loudly when the expect predicate does not match', async () => {
    const llm = await start();
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('密钥'))
        .replyText('ok'),
    ]);

    const res = await fetch(
      `${llm.url}/chat/completions`,
      completionRequest('mock-main', '无关内容'),
    );
    expect(res.status).toBe(500);
  });

  it('holds responses until released', async () => {
    const llm = await start();
    const gated = step().replyText('released');
    gated.hold();
    llm.script('mock-main', [gated]);

    const promise = fetch(`${llm.url}/chat/completions`, completionRequest('mock-main', 'hi'));
    await new Promise((resolve) => setTimeout(resolve, 150));

    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);

    llm.releaseAll();
    const res = await promise;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe('released');
  });

  it('keeps scripts for different models separate', async () => {
    const llm = await start();
    llm.script('mock-main', [step().replyText('main-reply')]);
    llm.script('mock-light', [step().replyJson({ decision: 'respond', confidence: 0.9 })]);

    const mainRes = await fetch(`${llm.url}/chat/completions`, completionRequest('mock-main', 'a'));
    const lightRes = await fetch(
      `${llm.url}/chat/completions`,
      completionRequest('mock-light', 'b'),
    );
    const mainBody = (await mainRes.json()) as { choices: Array<{ message: { content: string } }> };
    const lightBody = (await lightRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(mainBody.choices[0]?.message.content).toBe('main-reply');
    expect(JSON.parse(lightBody.choices[0]?.message.content ?? '{}')).toEqual({
      decision: 'respond',
      confidence: 0.9,
    });
  });

  it('exposes request-body inspection for secret-leak assertions', async () => {
    const llm = await start();
    llm.script('mock-main', [step().replyText('ok')]);
    await fetch(
      `${llm.url}/chat/completions`,
      completionRequest('mock-main', 'contains sk-live-123?'),
    );
    expect(llm.requestBodiesContain('sk-live-123')).toBe(true);
    expect(llm.requestBodiesContain('sk-other-secret')).toBe(false);
  });
});
