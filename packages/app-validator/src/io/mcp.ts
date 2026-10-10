import {
  McpClient,
  StreamableHttpTransport,
  type McpFetch,
  type Tool,
} from '@earendil-works/pi-mcp';
import type { UiResourceFacts } from '../checks/apps-ui.js';

/** tools/list + resources/read through pi-mcp's Streamable HTTP client. */

export interface McpSession {
  tools: Tool[];
  serverName: string | null;
  protocolVersion: string | null;
  readUiResource(uri: string): Promise<UiResourceFacts>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  url: string;
  fetch: McpFetch;
  accessToken?: string | undefined;
  timeoutMs: number;
}

export async function connectMcp(options: ConnectOptions): Promise<McpSession> {
  const transport = new StreamableHttpTransport({
    url: options.url,
    fetch: options.fetch,
    openGetStream: false,
    ...(options.accessToken !== undefined
      ? { authProvider: { token: async () => options.accessToken } }
      : {}),
  });
  const client = new McpClient({
    name: 'kepcup-app-validator',
    version: '0',
    requestTimeoutMs: options.timeoutMs,
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools({ timeoutMs: options.timeoutMs });
    return {
      tools,
      serverName: client.serverInfo?.name ?? null,
      protocolVersion: client.protocolVersion ?? null,
      async readUiResource(uri) {
        try {
          const result = await client.readResource(uri, { timeoutMs: options.timeoutMs });
          return {
            uri,
            read: {
              ok: true,
              contents: result.contents.map((content) => ({
                uri: content.uri,
                mimeType: content.mimeType,
                ...('text' in content ? { text: content.text } : {}),
                ...('blob' in content ? { blob: content.blob } : {}),
                ...(content._meta !== undefined ? { _meta: content._meta } : {}),
              })),
              ...(result._meta !== undefined ? { meta: result._meta } : {}),
            },
          };
        } catch (error) {
          return {
            uri,
            read: { ok: false, error: error instanceof Error ? error.message : String(error) },
          };
        }
      },
      close: () => client.close().catch(() => undefined),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
