import { describe, expect, it } from 'vitest';
import { projectScopeOf } from '../../src/domain/project-scope.js';

describe('projectScopeOf', () => {
  it('maps the full table', () => {
    expect(projectScopeOf(null)).toBeNull();
    expect(projectScopeOf(undefined)).toBeNull();
    expect(
      projectScopeOf({ type: 'direct', id: 'conv_d', parentProjectId: null, directBotId: 'bot' }),
    ).toBeNull();
    expect(projectScopeOf({ type: 'project', id: 'conv_p', parentProjectId: null })).toBe('conv_p');
    expect(projectScopeOf({ type: 'card', id: 'conv_c', parentProjectId: 'conv_p' })).toBe(
      'conv_p',
    );
    expect(projectScopeOf({ type: 'card', id: 'conv_c', parentProjectId: null })).toBeNull();
    expect(projectScopeOf({ type: 'card', id: 'conv_c' })).toBeNull();
    expect(projectScopeOf({ type: 'card', id: 'conv_c', parentProjectId: '' })).toBeNull();
    expect(projectScopeOf({ type: 'other', id: 'conv_x', parentProjectId: 'conv_p' })).toBeNull();
  });
});
