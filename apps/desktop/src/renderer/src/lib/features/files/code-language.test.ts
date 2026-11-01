import { describe, expect, it } from 'vitest';
import { codeLanguageOf } from './code-language';

describe('code language mapping', () => {
  it('maps common code extensions to shiki language ids', () => {
    expect(codeLanguageOf('/a/b/main.ts')).toEqual({ id: 'typescript', label: 'TypeScript' });
    expect(codeLanguageOf('/a/b/view.svelte')).toEqual({ id: 'svelte', label: 'Svelte' });
    expect(codeLanguageOf('/a/b/app.py')).toEqual({ id: 'python', label: 'Python' });
    expect(codeLanguageOf('/a/b/package.json')).toEqual({ id: 'json', label: 'JSON' });
    expect(codeLanguageOf('/a/b/deploy.yaml')).toEqual({ id: 'yaml', label: 'YAML' });
    expect(codeLanguageOf('/a/b/run.sh')).toEqual({ id: 'bash', label: 'Bash' });
    expect(codeLanguageOf('/a/b/query.sql')).toEqual({ id: 'sql', label: 'SQL' });
  });

  it('is case-insensitive on the extension', () => {
    expect(codeLanguageOf('/a/b/Main.TS')?.id).toBe('typescript');
    expect(codeLanguageOf('C:\\work\\App.SVELTE')?.id).toBe('svelte');
  });

  it('returns null for unknown / missing extensions', () => {
    expect(codeLanguageOf('/a/b/no-extension')).toBeNull();
    expect(codeLanguageOf('/a/b/binary.bin')).toBeNull();
    expect(codeLanguageOf('/a/b/README.txt')).toBeNull();
    expect(codeLanguageOf('')).toBeNull();
  });

  it('shares one language id across aliases', () => {
    expect(codeLanguageOf('/a/b/index.mjs')?.id).toBe(codeLanguageOf('/a/b/index.js')?.id);
    expect(codeLanguageOf('/a/b/header.h')?.id).toBe(codeLanguageOf('/a/b/main.c')?.id);
    expect(codeLanguageOf('/a/b/config.yml')?.id).toBe(codeLanguageOf('/a/b/config.yaml')?.id);
  });
});
