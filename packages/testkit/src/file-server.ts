import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local file server for environment-install tests (docs/dev/phases/
 * P06-environment.md "集成（下载使用本地模拟文件服务器）"): serves fixed byte
 * payloads so tests never touch the real release servers.
 */
export interface TestFileServer {
  url: string;
  port: number;
  requestsServed(): number;
  /** Adds or replaces a file while the server runs (e.g. a document that embeds `url`). */
  setFile(key: string, content: Buffer | string, contentType?: string): void;
  stop(): Promise<void>;
}

/** Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document) served in tests. */
export interface TestCimdDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  [key: string]: unknown;
}

export interface PublishCimdOptions {
  /** Path on the file server; default `oauth/client.json`. */
  path?: string;
  /** Default: loopback callback with any port plus one fixed-port form. */
  redirectUris?: string[];
  /** Overrides `client_id` inside the document (to test a mismatch with the URL). */
  clientIdInDocument?: string;
  /** Extra / overriding document fields. */
  extra?: Record<string, unknown>;
}

/**
 * Publishes a test CIMD document on `server` and returns its URL, which is
 * also the `client_id` (the document is self-referential, so it can only be
 * written once the file server's port is known).
 */
export function publishCimdDocument(
  server: TestFileServer,
  options: PublishCimdOptions = {},
): { clientId: string; document: TestCimdDocument } {
  const clientId = `${server.url}/${options.path ?? 'oauth/client.json'}`;
  const document: TestCimdDocument = {
    client_id: options.clientIdInDocument ?? clientId,
    client_name: 'KepCup (test)',
    redirect_uris: options.redirectUris ?? ['http://127.0.0.1/callback', 'http://127.0.0.1:53682/callback'],
    token_endpoint_auth_method: 'none',
    ...options.extra,
  };
  server.setFile(options.path ?? 'oauth/client.json', JSON.stringify(document), 'application/json');
  return { clientId, document };
}

export function startFileServer(files: Record<string, Buffer | string>): Promise<TestFileServer> {
  let served = 0;
  const contentTypes = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const key = (req.url ?? '/').replace(/^\//, '');
    const file = files[key];
    if (file === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const body = typeof file === 'string' ? Buffer.from(file, 'utf8') : file;
    served += 1;
    res.writeHead(200, {
      'content-type': contentTypes.get(key) ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requestsServed: () => served,
        setFile: (key, content, contentType) => {
          files[key] = content;
          if (contentType !== undefined) contentTypes.set(key, contentType);
        },
        stop: () => new Promise<void>((resolveStop) => server.close(() => resolveStop())),
      });
    });
  });
}
