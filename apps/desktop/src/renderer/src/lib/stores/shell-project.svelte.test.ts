import { beforeEach, describe, expect, it } from 'vitest';
import { shell } from './shell.svelte';

/**
 * 项目组外壳状态（WP6 §4.11）：projectView / projectSettingsSection 与两个
 * 打开方法。用真实 shell store（desktop-svelte 项目，真 $state）。
 */

beforeEach(() => {
  shell.projectView = 'chat';
  shell.projectSettingsSection = 'overview';
});

describe('projectView 默认与重置', () => {
  it('默认是 chat', () => {
    expect(shell.projectView).toBe('chat');
    expect(shell.projectSettingsSection).toBe('overview');
  });
});

describe('openProjectSettings', () => {
  it('同时设视图与分区', () => {
    shell.openProjectSettings('members');
    expect(shell.projectView).toBe('settings');
    expect(shell.projectSettingsSection).toBe('members');
  });

  it('不带分区回概览', () => {
    shell.openProjectSettings('danger');
    shell.openProjectSettings();
    expect(shell.projectView).toBe('settings');
    expect(shell.projectSettingsSection).toBe('overview');
  });
});

describe('openProjectModule', () => {
  it('planned 模块（okr / calendar）被忽略，board 可切换', () => {
    shell.openProjectModule('okr');
    expect(shell.projectView).toBe('chat');
    shell.openProjectModule('board');
    expect(shell.projectView).toBe('board');
    shell.openProjectModule('calendar');
    expect(shell.projectView).toBe('board');
  });

  it('available 模块（board / wiki）生效，再切回 chat', () => {
    shell.openProjectModule('board');
    expect(shell.projectView).toBe('board');
    shell.openProjectModule('wiki');
    expect(shell.projectView).toBe('wiki');
    shell.openProjectModule('chat');
    expect(shell.projectView).toBe('chat');
  });

  it('从 settings 视图也能切回模块（详情页不是 tab，任何 tab 点击都返回沟通）', () => {
    shell.openProjectSettings('members');
    shell.openProjectModule('chat');
    expect(shell.projectView).toBe('chat');
  });
});
