import { describe, expect, it } from 'vitest';
import { botProfileSchema, type BotProfile } from '@kepcup/shared';
import { deepEqual, isEngineOnlyChange, reconcileBotDraft } from './bot-draft';

function profile(model: string, bio = ''): BotProfile {
  return botProfileSchema.parse({
    identity: { name: '测', bio },
    runtime: { model },
  });
}

describe('reconcileBotDraft', () => {
  it('replaces with the server profile when switching bots', () => {
    const draft = profile('a/b');
    const server = profile('c/d');
    expect(
      reconcileBotDraft({ sameBot: false, draft, savedProfile: draft, serverProfile: server }),
    ).toEqual({ action: 'replace', draft: server });
  });

  it('keeps a dirty draft when the same bot is refreshed with an unchanged profile', () => {
    const saved = profile('');
    const draft = profile('zai-coding-cn/glm-5.3');
    expect(
      reconcileBotDraft({ sameBot: true, draft, savedProfile: saved, serverProfile: saved }),
    ).toEqual({ action: 'keep' });
  });

  it('accepts a changed server profile when the draft is clean', () => {
    const saved = profile('', '旧简介');
    const server = profile('', '新简介');
    expect(
      reconcileBotDraft({ sameBot: true, draft: saved, savedProfile: saved, serverProfile: server }),
    ).toEqual({ action: 'replace', draft: server });
  });

  it('keeps a clean draft when the server profile is unchanged (no effect loop)', () => {
    const saved = profile('');
    expect(
      reconcileBotDraft({ sameBot: true, draft: saved, savedProfile: saved, serverProfile: saved }),
    ).toEqual({ action: 'keep' });
  });

  it('replaces when draft or savedProfile is missing', () => {
    const server = profile('');
    expect(
      reconcileBotDraft({ sameBot: true, draft: null, savedProfile: null, serverProfile: server }),
    ).toEqual({ action: 'replace', draft: server });
  });

  it('merges per field: local edits survive, untouched fields follow the server', () => {
    const saved = profile('', '旧简介');
    const draft = profile('a/b', '旧简介'); // user changed the model
    const server = profile('', '新简介'); // the bot updated its own bio meanwhile
    const result = reconcileBotDraft({
      sameBot: true,
      draft,
      savedProfile: saved,
      serverProfile: server,
    });
    expect(result.action).toBe('replace');
    if (result.action !== 'replace') return;
    expect(result.draft.runtime.model).toBe('a/b');
    expect(result.draft.identity.bio).toBe('新简介');
  });

  it('prefers the local value when both sides changed the same field', () => {
    const saved = profile('', 'x');
    const result = reconcileBotDraft({
      sameBot: true,
      draft: profile('', '本地'),
      savedProfile: saved,
      serverProfile: profile('', '服务端'),
    });
    expect(result.action === 'replace' && result.draft.identity.bio).toBe('本地');
  });
});

describe('deepEqual', () => {
  it('ignores key order but not values or array order', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [2, 1] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('isEngineOnlyChange', () => {
  it('is true when only runtime.model changed', () => {
    expect(isEngineOnlyChange(profile(''), profile('a/b'))).toBe(true);
  });

  it('is false when persona also changed', () => {
    const saved = profile('');
    const draft = botProfileSchema.parse({
      ...profile('a/b'),
      persona: { ...profile('a/b').persona, tone: '冷静' },
    });
    expect(isEngineOnlyChange(saved, draft)).toBe(false);
  });

  it('is false when nothing engine-related changed', () => {
    const saved = profile('a/b');
    expect(isEngineOnlyChange(saved, saved)).toBe(false);
  });
});
