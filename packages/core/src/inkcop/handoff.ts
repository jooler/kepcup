import { randomUUID } from 'node:crypto';
import {
  InkcopAgentNotExposedError,
  InkcopAuthError,
  InkcopHttpError,
  InkcopLocalBridgeClient,
  InkcopOfflineError,
  inkcopAgentNotExposedTip,
  inkcopAuthTip,
  inkcopOfflineTip,
} from './client.js';
import { inkcopExternalId, inkcopMessageId } from './index.js';

/**
 * InkCop 智能体单次移交（契约 v0.4）：给工具/任务用。
 * 不落对话气泡——由调用方把结果写回 Bot 工具结果或任务。
 */

export interface InkcopHandoffInput {
  botId: string;
  botName: string;
  agentKey: string;
  /** 交给 InkCop 智能体的任务说明 / 用户原文。 */
  text: string;
  signal?: AbortSignal;
  /** 界面语言；en → 英文鉴权/离线提示。 */
  uiLanguage?: string | null;
}

export type InkcopHandoffResult =
  | { ok: true; text: string; connectionId: string }
  | {
      ok: false;
      errorCode: 'offline' | 'auth' | 'empty' | 'http' | 'error' | 'not_exposed';
      message: string;
    };

/**
 * ensureConnection → POST /v1/messages（SSE）→ 收集 complete 全文。
 */
export async function handoffToInkcopAgent(
  client: InkcopLocalBridgeClient,
  input: InkcopHandoffInput,
): Promise<InkcopHandoffResult> {
  const offlineTip = inkcopOfflineTip(input.uiLanguage);
  const authTip = inkcopAuthTip(input.uiLanguage);
  const notExposedTip = inkcopAgentNotExposedTip(input.uiLanguage);
  const text = input.text.trim();
  if (text.length === 0) {
    return { ok: false, errorCode: 'empty', message: '任务内容为空，未发送到 InkCop' };
  }

  const agentKey = input.agentKey.trim() || 'main_agent';
  let connectionId: string;
  try {
    const connection = await client.ensureConnection(
      {
        externalId: inkcopExternalId(input.botId, agentKey),
        name: `KepCup · ${input.botName}`,
        agentKey,
      },
      input.signal,
    );
    connectionId = connection.connectionId;
  } catch (error) {
    if (error instanceof InkcopAuthError) {
      return { ok: false, errorCode: 'auth', message: authTip };
    }
    if (error instanceof InkcopOfflineError) {
      return { ok: false, errorCode: 'offline', message: offlineTip };
    }
    if (error instanceof InkcopAgentNotExposedError) {
      return { ok: false, errorCode: 'not_exposed', message: notExposedTip };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, errorCode: 'http', message: `连接 InkCop 失败：${msg}` };
  }

  const stream = { accumulated: '', completed: null as string | null, error: null as string | null };

  try {
    await client.sendMessage(
      {
        connectionId,
        messageId: inkcopMessageId(randomUUID()),
        text,
        stream: true,
      },
      {
        onChunk: async (data) => {
          stream.accumulated += data.text;
        },
        onComplete: async (data) => {
          stream.completed = data.text;
        },
        onError: async (data) => {
          stream.error = data.message ?? data.error;
        },
      },
      input.signal,
    );
  } catch (error) {
    if (error instanceof InkcopAuthError) {
      return { ok: false, errorCode: 'auth', message: authTip };
    }
    if (error instanceof InkcopOfflineError) {
      return { ok: false, errorCode: 'offline', message: offlineTip };
    }
    if (error instanceof InkcopAgentNotExposedError) {
      return { ok: false, errorCode: 'not_exposed', message: notExposedTip };
    }
    if (error instanceof InkcopHttpError) {
      return { ok: false, errorCode: 'http', message: `InkCop 通讯失败：${error.message}` };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, errorCode: 'error', message: `InkCop 通讯失败：${msg}` };
  }

  if (stream.error !== null) {
    return { ok: false, errorCode: 'error', message: stream.error };
  }

  const candidate =
    stream.completed !== null && stream.completed.length > 0 ? stream.completed : stream.accumulated;
  const finalText = candidate.trim();
  if (finalText.length === 0) {
    return { ok: false, errorCode: 'empty', message: 'InkCop 未返回内容' };
  }
  return { ok: true, text: finalText, connectionId };
}
