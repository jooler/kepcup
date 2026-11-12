import { describe, expect, it } from 'vitest';

import {
  buildConnectUrl,
  normalizeAddressInput,
  relayOrigin,
  resolveConnectTarget,
  targetId,
  targetLabel,
} from '../src/lib/connect';

/** 桌面端 pairingQrUrl 的产物形状(core pairing.ts):<origin>/#pair=<relay>,<sid>,<secret>。 */
const QR_URL =
  'https://remote.kepcup.com/#pair=' +
  encodeURIComponent('wss://remote.kepcup.com/ws/d96') +
  ',01J0000000000000000000000A,ab-cd_efgh-ijkl';

const LAN_QR_URL =
  'http://192.168.1.5:8642/#pair=' +
  encodeURIComponent('ws://192.168.1.5:8642/ws') +
  ',01J0000000000000000000000B,mnopqrstuvwx';

describe('resolveConnectTarget', () => {
  it('整条配对链接 → pairing 目标(保留扫码原文)', () => {
    const target = resolveConnectTarget(`  ${QR_URL}  `);
    expect(target?.kind).toBe('pairing');
    if (target?.kind !== 'pairing') return;
    expect(target.sourceUrl.trim()).toBe(QR_URL);
    expect(target.link.sessionId).toBe('01J0000000000000000000000A');
  });

  it('裸 #pair= 片段(无 origin)也是 pairing 目标', () => {
    const target = resolveConnectTarget(
      '#pair=ws%3A%2F%2F127.0.0.1%3A8787,01J0000000000000000000000C,secret-value',
    );
    expect(target?.kind).toBe('pairing');
  });

  it('http 服务地址 → server 目标', () => {
    const target = resolveConnectTarget('http://192.168.1.5:8642');
    expect(target).toEqual({ kind: 'server', url: 'http://192.168.1.5:8642/' });
  });

  it('无关二维码文本 → null', () => {
    expect(resolveConnectTarget('https://example.com/some/page')).toEqual({
      kind: 'server',
      url: 'https://example.com/some/page',
    });
    expect(resolveConnectTarget('随便什么文本')).toBeNull();
    expect(resolveConnectTarget('')).toBeNull();
  });

  it('#pair= 但载荷不合法 → null(不是合法配对码)', () => {
    expect(resolveConnectTarget('https://remote.kepcup.com/#pair=not,a,valid')).toBeNull();
  });
});

describe('normalizeAddressInput', () => {
  it('补协议:裸 IP:端口 → http', () => {
    expect(normalizeAddressInput('192.168.1.5:8642')).toBe('http://192.168.1.5:8642/');
  });

  it('补协议:localhost 与 .local → http', () => {
    expect(normalizeAddressInput('localhost:8642')).toBe('http://localhost:8642/');
    expect(normalizeAddressInput('kepcup.local')).toBe('http://kepcup.local/');
  });

  it('补协议:裸域名无端口 → https', () => {
    expect(normalizeAddressInput('kepcup.example.com')).toBe('https://kepcup.example.com/');
  });

  it('补协议:方括号 IPv6(审查补测)→ http 且端口进 authority', () => {
    expect(normalizeAddressInput('[::1]:8642')).toBe('http://[::1]:8642/');
    expect(normalizeAddressInput('[fe80::1]')).toBe('http://[fe80::1]/');
  });

  it('裸 IPv6(无方括号)与端口越界拒绝(审查补测)', () => {
    expect(normalizeAddressInput('::1')).toBeNull();
    expect(normalizeAddressInput('192.168.1.5:99999')).toBeNull();
  });

  it('大小写与端口 0(审查补测)', () => {
    expect(normalizeAddressInput('HTTP://EXAMPLE.COM')).toBe('http://example.com/');
    expect(normalizeAddressInput('LOCALHOST:8642')).toBe('http://localhost:8642/');
    expect(normalizeAddressInput('192.168.1.5:0')).toBe('http://192.168.1.5:0/');
  });

  it('带协议原样保留(含路径)', () => {
    expect(normalizeAddressInput('https://kepcup.example.com/headless/')).toBe(
      'https://kepcup.example.com/headless/',
    );
  });

  it('配对链接与乱输入 → null', () => {
    expect(normalizeAddressInput(`https://x/#pair=a,b,c`)).toBeNull();
    expect(normalizeAddressInput('not a host!')).toBeNull();
    expect(normalizeAddressInput('')).toBeNull();
  });
});

describe('buildConnectUrl', () => {
  const HOME = 'capacitor://localhost/index.html';

  it('配对链接:origin 保留、shell 参数在 hash 前、shellBack 编码可还原', () => {
    const target = resolveConnectTarget(QR_URL);
    if (target?.kind !== 'pairing') throw new Error('expected pairing');
    const built = buildConnectUrl(target, HOME);
    const url = new URL(built);
    expect(url.origin).toBe('https://remote.kepcup.com');
    expect(url.searchParams.get('shell')).toBe('native');
    expect(url.searchParams.get('shellBack')).toBe(HOME);
    expect(url.hash.startsWith('#pair=')).toBe(true);
    // 参数必须在 hash 之前:URL 构造已保证;这里钉住顺序防回归。
    expect(built.indexOf('?shell=native')).toBeLessThan(built.indexOf('#pair='));
  });

  it('自建反代子路径的配对链接保留 pathname', () => {
    const withPath = QR_URL.replace('https://remote.kepcup.com/', 'https://relay.example.com/app/');
    const target = resolveConnectTarget(withPath);
    if (target?.kind !== 'pairing') throw new Error('expected pairing');
    const built = new URL(buildConnectUrl(target, HOME));
    expect(built.pathname).toBe('/app/');
  });

  it('裸 #pair= 片段按中转协议推导源(wss→https,ws→http)', () => {
    const target = resolveConnectTarget(
      '#pair=ws%3A%2F%2F192.168.1.5%3A8642%2Fws,01J0000000000000000000000D,secret-value',
    );
    if (target?.kind !== 'pairing') throw new Error('expected pairing');
    const built = new URL(buildConnectUrl(target, HOME));
    expect(built.origin).toBe('http://192.168.1.5:8642');
    expect(built.hash.startsWith('#pair=')).toBe(true);
  });

  it('LAN 配对二维码整条 URL 直连源', () => {
    const target = resolveConnectTarget(LAN_QR_URL);
    if (target?.kind !== 'pairing') throw new Error('expected pairing');
    const built = new URL(buildConnectUrl(target, HOME));
    expect(built.origin).toBe('http://192.168.1.5:8642');
  });

  it('server 目标:参数注入且原查询串保留', () => {
    const target = resolveConnectTarget('http://192.168.1.5:8642');
    if (target?.kind !== 'server') throw new Error('expected server');
    const built = new URL(buildConnectUrl(target, HOME));
    expect(built.searchParams.get('shell')).toBe('native');
    expect(built.searchParams.get('shellBack')).toBe(HOME);
  });

  it('shellBack 在客户端侧可用 URLSearchParams 还原(交接契约)', () => {
    const target = resolveConnectTarget(LAN_QR_URL);
    if (target?.kind !== 'pairing') throw new Error('expected pairing');
    const home = 'https://localhost/index.html';
    const built = buildConnectUrl(target, home);
    // 客户端页面读取(location.search)时的形状。
    const search = new URL(built).search;
    expect(new URLSearchParams(search).get('shellBack')).toBe(home);
  });
});

describe('relayOrigin', () => {
  it('wss→https,ws→http(与 core pairingQrUrl 同款推导)', () => {
    expect(relayOrigin('wss://remote.kepcup.com/ws')).toBe('https://remote.kepcup.com/ws');
    expect(relayOrigin('ws://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });

  it('非 ws(s) 输入原样返回(审查补测:公开导出的防御行为)', () => {
    expect(relayOrigin('https://example.com')).toBe('https://example.com');
    expect(relayOrigin('')).toBe('');
  });
});

describe('targetLabel / targetId', () => {
  it('配对目标 label 取扫码源 host(自建/公共一致)', () => {
    const target = resolveConnectTarget(QR_URL);
    if (target?.kind !== 'pairing') throw new Error('expected pairing');
    expect(targetLabel(target)).toBe('remote.kepcup.com');
    expect(targetId(target)).toBe('pairing:remote.kepcup.com:01J0000000000000000000000A');
  });

  it('同一公共中转上的两台桌面(sessionId 不同)id 不同(审查补测:去重键不撞车)', () => {
    const qr = (sid: string) =>
      `https://remote.kepcup.com/#pair=${encodeURIComponent('wss://remote.kepcup.com/ws')},${sid},AAAA-vvvv-1111-2222`;
    const a = resolveConnectTarget(qr('01J0000000000000000000000A'));
    const b = resolveConnectTarget(qr('01J0000000000000000000000B'));
    if (a?.kind !== 'pairing' || b?.kind !== 'pairing') throw new Error('expected pairing');
    expect(targetId(a)).not.toBe(targetId(b));
  });

  it('服务目标 label 取 host:port,id 含完整规范化 URL', () => {
    const target = resolveConnectTarget('192.168.1.5:8642');
    if (target?.kind !== 'server') throw new Error('expected server');
    expect(targetLabel(target)).toBe('192.168.1.5:8642');
    expect(targetId(target)).toBe(`server:${target.url}`);
  });
});
