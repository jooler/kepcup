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
  stop(): Promise<void>;
}

export function startFileServer(files: Record<string, Buffer | string>): Promise<TestFileServer> {
  let served = 0;
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
      'content-type': 'application/octet-stream',
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
        stop: () => new Promise<void>((resolveStop) => server.close(() => resolveStop())),
      });
    });
  });
}
