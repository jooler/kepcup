import { describe, expect, test } from 'vitest';
import { isCorePortMessage } from './port';

describe('isCorePortMessage', () => {
  const self = {};
  const port = {} as MessagePort;
  const genuine = { type: 'core-port', nonce: 'secret-nonce' };

  test('accepts the preload hand-over: same window, right nonce, with a port', () => {
    expect(
      isCorePortMessage(
        { data: genuine, source: self as never, ports: [port] },
        self,
        'secret-nonce',
      ),
    ).toBe(true);
  });

  test('rejects a message from another window (a sandboxed iframe) even with a port', () => {
    const iframe = {};
    expect(
      isCorePortMessage(
        { data: genuine, source: iframe as never, ports: [port] },
        self,
        'secret-nonce',
      ),
    ).toBe(false);
    expect(
      isCorePortMessage(
        { data: 'core-port', source: iframe as never, ports: [port] },
        self,
        'secret-nonce',
      ),
    ).toBe(false);
  });

  test('rejects the legacy bare-string form, a wrong / missing nonce, no port, null source', () => {
    const accept = (data: unknown, ports: MessagePort[] = [port], source: unknown = self) =>
      isCorePortMessage({ data, source: source as never, ports }, self, 'secret-nonce');
    expect(accept('core-port')).toBe(false);
    expect(accept({ type: 'core-port' })).toBe(false);
    expect(accept({ type: 'core-port', nonce: 'guess' })).toBe(false);
    expect(accept({ type: 'core-port', nonce: 123 })).toBe(false);
    expect(accept({ type: 'other', nonce: 'secret-nonce' })).toBe(false);
    expect(accept(null)).toBe(false);
    expect(accept(genuine, [])).toBe(false);
    expect(accept(genuine, [port], null)).toBe(false);
  });

  test('an empty page nonce never matches', () => {
    expect(
      isCorePortMessage(
        { data: { type: 'core-port', nonce: '' }, source: self as never, ports: [port] },
        self,
        '',
      ),
    ).toBe(false);
  });
});
