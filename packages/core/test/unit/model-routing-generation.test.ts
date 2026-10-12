import { afterEach, describe, expect, it } from 'vitest';
import {
  botRuntimeAffectsModelRouting,
  modelRoutingGeneration,
  resetModelRoutingGeneration,
  settingsAffectModelRouting,
} from '../../src/agent/model-routing-generation.js';
import { SettingsService } from '../../src/domain/settings.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

let env: RealMainDb | undefined;

afterEach(() => {
  env?.dispose();
  env = undefined;
  resetModelRoutingGeneration();
});

describe('model routing generation', () => {
  it('detects default main/light and Bot runtime model changes', () => {
    expect(
      settingsAffectModelRouting(
        { defaultMainModel: 'a/x', defaultLightModel: 'a/y' },
        { defaultMainModel: 'a/x', defaultLightModel: 'a/y' },
      ),
    ).toBe(false);
    expect(
      settingsAffectModelRouting(
        { defaultMainModel: 'a/x', defaultLightModel: 'a/y' },
        { defaultMainModel: 'b/z', defaultLightModel: 'a/y' },
      ),
    ).toBe(true);

    const base = { model: '', light_model: '', agent: { id: '', model: '' } };
    expect(botRuntimeAffectsModelRouting(base, base)).toBe(false);
    expect(botRuntimeAffectsModelRouting(base, { ...base, light_model: 'p/m' })).toBe(true);
    expect(
      botRuntimeAffectsModelRouting(base, {
        ...base,
        agent: { id: 'claude-code', model: 'default' },
      }),
    ).toBe(true);
  });

  it('settings.update bumps generation when default models change', () => {
    env = openRealMainDb();
    const settings = new SettingsService(env.db, env.clock);
    const before = modelRoutingGeneration();
    settings.update({ defaultLightModel: 'custom:mock/mock-light' });
    expect(modelRoutingGeneration()).toBe(before + 1);
    // Unrelated / same-value write: no bump.
    const mid = modelRoutingGeneration();
    settings.update({ locale: settings.get().locale });
    expect(modelRoutingGeneration()).toBe(mid);
  });
});
