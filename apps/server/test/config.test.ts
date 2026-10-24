import { describe, expect, it } from 'vitest';
import { parseConfig, ConfigError } from '../src/config.js';

/** CLI 解析（D102 §3.3）：默认值、publicUrl 推导、互斥与非法值报错。 */

const BASE_ENV = { ...process.env };
const savedEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KEPCUP_SERVER_')) delete process.env[key];
  }
};

describe('parseConfig', () => {
  it('缺省子命令是 run，缺省 host/port/dataDir', () => {
    savedEnv();
    const config = parseConfig([]);
    expect(config.command).toBe('run');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8642);
    expect(config.dataDir).toContain('.kepcup-server');
    expect(config.publicUrl).toBe('ws://127.0.0.1:8642');
    expect(config.keystore).toBe('system');
  });

  it('通配 host 必须显式给 public-url', () => {
    savedEnv();
    expect(() => parseConfig(['--host', '0.0.0.0'])).toThrow(ConfigError);
    const config = parseConfig(['--host', '0.0.0.0', '--public-url', 'wss://nas.example.com']);
    expect(config.publicUrl).toBe('wss://nas.example.com');
    expect(config.publicUrlExplicit).toBe(true);
  });

  it('public-url 只接受 ws/wss', () => {
    savedEnv();
    expect(() => parseConfig(['--public-url', 'https://nas.example.com'])).toThrow(ConfigError);
  });

  it('--relay 与 --public-url 互斥', () => {
    savedEnv();
    expect(() =>
      parseConfig(['--relay', 'wss://remote.kepcup.com', '--public-url', 'ws://x:1']),
    ).toThrow(ConfigError);
  });

  it('环境变量兜底同名参数', () => {
    savedEnv();
    process.env.KEPCUP_SERVER_PORT = '9000';
    process.env.KEPCUP_SERVER_PUBLIC_URL = 'ws://nas.local:9000';
    const config = parseConfig([]);
    expect(config.port).toBe(9000);
    expect(config.publicUrl).toBe('ws://nas.local:9000');
    savedEnv();
    Object.assign(process.env, BASE_ENV);
  });

  it('子命令与参数解析', () => {
    savedEnv();
    const config = parseConfig([
      'pair',
      '--data-dir', '/tmp/ks',
      '--accept', 'req-1',
      '--json',
    ]);
    expect(config.command).toBe('pair');
    expect(config.acceptRequestId).toBe('req-1');
    expect(config.json).toBe(true);

    const devices = parseConfig(['devices', 'revoke', '--revoke', 'dev-1']);
    expect(devices.command).toBe('devices');
    expect(devices.revokeDeviceId).toBe('dev-1');
  });

  it('非法端口 / keystore / 子命令报错', () => {
    savedEnv();
    expect(() => parseConfig(['--port', 'nope'])).toThrow(ConfigError);
    expect(() => parseConfig(['--keystore', 'yolo'])).toThrow(ConfigError);
    expect(() => parseConfig(['frobnicate'])).toThrow(ConfigError);
    expect(() => parseConfig(['--host'])).toThrow(ConfigError);
  });
});
