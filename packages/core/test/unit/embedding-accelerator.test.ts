import { describe, expect, it } from 'vitest';

import { acceleratorLabel, executionProvidersFor } from '../../src/env/gpu.js';

describe('embedding accelerator selection (P07 / DEV-007)', () => {
  it('prefers CoreML on macOS with CPU fallback', () => {
    expect(executionProvidersFor('darwin', 'arm64')).toEqual(['coreml', 'cpu']);
    expect(executionProvidersFor('darwin', 'x64')).toEqual(['coreml', 'cpu']);
    expect(acceleratorLabel('darwin')).toBe('CoreML');
  });

  it('prefers DirectML on Windows (any DX12 GPU) with CPU fallback', () => {
    expect(executionProvidersFor('win32', 'x64')).toEqual(['dml', 'cpu']);
    expect(executionProvidersFor('win32', 'arm64')).toEqual(['dml', 'cpu']);
    expect(acceleratorLabel('win32')).toBe('DirectML');
  });

  it('uses CPU only on Linux (npm package ships no CUDA EP)', () => {
    expect(executionProvidersFor('linux', 'x64')).toEqual(['cpu']);
    expect(executionProvidersFor('linux', 'arm64')).toEqual(['cpu']);
    expect(acceleratorLabel('linux')).toBe('CPU');
  });
});
