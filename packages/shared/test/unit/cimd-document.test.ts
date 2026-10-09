import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  KEPCUP_OAUTH_CLIENT_ID,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORTS,
} from '../../src/constants';

/**
 * KepCup 的 OAuth 客户端元数据文档（CIMD，设计 29 §5.2 / §15.1）与代码常量保持
 * 一致：授权服务器按 `client_id` URL 抓取该文档并校验，任何一项失配都会 `invalid_client`。
 */

const CIMD_URL = new URL(
  '../../../../infra/cloudflare/oauth-cimd/public/oauth/client.json',
  import.meta.url,
);
const raw = readFileSync(CIMD_URL);
const doc = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;

describe('CIMD document (infra/cloudflare/oauth-cimd)', () => {
  it('client_id equals the client id constant and the document URL, verbatim', () => {
    expect(doc.client_id).toBe(KEPCUP_OAUTH_CLIENT_ID);
    expect(KEPCUP_OAUTH_CLIENT_ID).toBe('https://kepcup.com/oauth/client.json');
    expect(new URL(KEPCUP_OAUTH_CLIENT_ID).pathname).toBe('/oauth/client.json');
  });

  it('redirect_uris cover the loopback redirect and every fixed callback port', () => {
    const uris = doc.redirect_uris as string[];
    expect(uris).toContain(`http://127.0.0.1${OAUTH_CALLBACK_PATH}`);
    for (const port of OAUTH_CALLBACK_PORTS) {
      expect(uris).toContain(`http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`);
    }
    expect(uris).toHaveLength(OAUTH_CALLBACK_PORTS.length + 1);
  });

  it('is at most 5 KB', () => {
    expect(raw.byteLength).toBeLessThanOrEqual(5 * 1024);
  });

  it('never mentions localhost (RFC 8252 §8.3: use the 127.0.0.1 literal)', () => {
    expect(raw.toString('utf8').toLowerCase()).not.toContain('localhost');
  });

  it('is a public native client using the code flow', () => {
    expect(doc.client_name).toBe('KepCup');
    expect(doc.client_uri).toBe('https://kepcup.com');
    expect(doc.token_endpoint_auth_method).toBe('none');
    expect(doc.response_types).toEqual(['code']);
    expect(doc.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(typeof doc.logo_uri).toBe('string');
    expect(typeof doc.policy_uri).toBe('string');
    // 公共客户端不得携带密钥字段。
    expect(doc).not.toHaveProperty('client_secret');
  });

  it('serves /oauth/* as cacheable JSON with open CORS and no redirects configured', () => {
    const headers = readFileSync(
      new URL('../../../../infra/cloudflare/oauth-cimd/public/_headers', import.meta.url),
      'utf8',
    );
    expect(headers).toContain('/oauth/*');
    expect(headers).toContain('Content-Type: application/json');
    expect(headers).toContain('Cache-Control: public, max-age=86400');
    expect(headers).toContain('Access-Control-Allow-Origin: *');
    expect(existsRedirects()).toBe(false);
  });
});

/** Cloudflare 静态资源的 `_redirects` 文件会让 /oauth/* 重定向——这里不得存在。 */
function existsRedirects(): boolean {
  try {
    readFileSync(
      new URL('../../../../infra/cloudflare/oauth-cimd/public/_redirects', import.meta.url),
    );
    return true;
  } catch {
    return false;
  }
}
