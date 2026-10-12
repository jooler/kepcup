import { describe, expect, it } from 'vitest';
import { botProfileSchema, type BotProfile } from '@kepcup/shared';
import { isEngineOnlyChange, shouldReloadBotDraft } from './bot-draft';

function profile(model: string, bio = ''): BotProfile {
  return botProfileSchema.parse({
    identity: { name: '测', bio },
    runtime: { model },
  });
}

describe('shouldReloadBotDraft', () => {
  it('reloads when switching bots', () => {
    const draft = profile('a/b');
    expect(
      shouldReloadBotDraft({
        sameBot: false,
        draft,
        savedProfile: draft,
        serverProfile: draft,
      }),
    ).toBe('reload');
  });

  it('keeps a dirty draft when the same bot is refreshed from the store', () => {
    const saved = profile('');
    const draft = profile('zai-coding-cn/glm-5.3');
    expect(
      shouldReloadBotDraft({
        sameBot: true,
        draft,
        savedProfile: saved,
        serverProfile: saved,
      }),
    ).toBe('keep');
  });

  it('reloads a clean draft when the server profile actually changed', () => {
    const saved = profile('', '旧简介');
    const server = profile('', '新简介');
    expect(
      shouldReloadBotDraft({
        sameBot: true,
        draft: saved,
        savedProfile: saved,
        serverProfile: server,
      }),
    ).toBe('reload');
  });

  it('keeps a clean draft when the server profile is unchanged (no effect loop)', () => {
    const saved = profile('');
    expect(
      shouldReloadBotDraft({
        sameBot: true,
        draft: saved,
        savedProfile: saved,
        serverProfile: saved,
      }),
    ).toBe('keep');
  });

  it('reloads when draft or savedProfile is missing', () => {
    expect(
      shouldReloadBotDraft({
        sameBot: true,
        draft: null,
        savedProfile: null,
        serverProfile: profile(''),
      }),
    ).toBe('reload');
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
