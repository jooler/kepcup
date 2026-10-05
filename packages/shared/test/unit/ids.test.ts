import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, isId, newId } from '../../src/ids.js';

describe('newId', () => {
  it('uses the documented prefix per entity kind', () => {
    expect(newId('bot').startsWith(ID_PREFIXES.bot)).toBe(true);
    expect(newId('conv').startsWith(ID_PREFIXES.conv)).toBe(true);
    expect(newId('msg').startsWith(ID_PREFIXES.msg)).toBe(true);
    expect(newId('run').startsWith(ID_PREFIXES.run)).toBe(true);
    expect(newId('sec').startsWith(ID_PREFIXES.sec)).toBe(true);
  });

  it('produces unique ids', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newId('msg')));
    expect(seen.size).toBe(1000);
  });

  it('isId validates prefix membership', () => {
    const id = newId('bot');
    expect(isId('bot', id)).toBe(true);
    expect(isId('conv', id)).toBe(false);
  });
});
