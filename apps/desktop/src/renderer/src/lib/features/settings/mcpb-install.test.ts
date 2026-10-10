import { describe, expect, it } from 'vitest';
import type { McpbUserConfigField } from '@kepcup/shared';
import {
  buildUserConfig,
  canInstall,
  clearSensitive,
  formatBytes,
  initialForm,
  missingRequired,
} from './mcpb-install';

const field = (patch: Partial<McpbUserConfigField> & { key: string }): McpbUserConfigField => ({
  type: 'string',
  title: patch.key,
  description: '',
  required: false,
  sensitive: false,
  multiple: false,
  ...patch,
});

describe('mcpb install form helpers', () => {
  const fields = [
    field({ key: 'api_key', title: 'API Key', required: true, sensitive: true }),
    field({ key: 'port', type: 'number', default: 8080 }),
    field({ key: 'verbose', type: 'boolean', default: true }),
    field({ key: 'roots', type: 'directory', multiple: true }),
  ];

  it('seeds the form from defaults', () => {
    expect(initialForm(fields)).toEqual({ api_key: '', port: '8080', verbose: true, roots: '' });
  });

  it('lists missing required fields by title', () => {
    expect(missingRequired(fields, initialForm(fields))).toEqual(['API Key']);
    expect(missingRequired(fields, { ...initialForm(fields), api_key: '  ' })).toEqual(['API Key']);
    expect(missingRequired(fields, { ...initialForm(fields), api_key: 'k' })).toEqual([]);
  });

  it('builds typed userConfig, dropping empty values', () => {
    const form = { api_key: 'sk', port: '9090', verbose: false, roots: '/a\n\n /b ' };
    expect(buildUserConfig(fields, form)).toEqual({
      api_key: 'sk',
      port: 9090,
      verbose: false,
      roots: ['/a', '/b'],
    });
    expect(buildUserConfig(fields, { ...form, port: '', roots: '' })).toEqual({
      api_key: 'sk',
      verbose: false,
    });
  });

  it('clears only sensitive fields after submit', () => {
    expect(clearSensitive(fields, { api_key: 'sk', port: '1', verbose: true, roots: '' })).toEqual({
      api_key: '',
      port: '1',
      verbose: true,
      roots: '',
    });
  });

  it('gates the install button', () => {
    expect(canInstall({ compatible: true, runtime: null, missing: [] })).toBe(true);
    expect(canInstall({ compatible: false, runtime: null, missing: [] })).toBe(false);
    expect(canInstall({ compatible: true, runtime: { available: false }, missing: [] })).toBe(
      false,
    );
    expect(canInstall({ compatible: true, runtime: { available: true }, missing: ['x'] })).toBe(
      false,
    );
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
