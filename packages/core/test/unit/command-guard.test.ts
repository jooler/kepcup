import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { catastrophicCommandVerdict } from '../../src/permissions/command-guard.js';

// This suite pins platform: 'darwin'. Fixtures must stay POSIX: `path.join` on
// a Windows runner rewrites `/Users/tester` to `\Users\tester`, which the
// POSIX resolver does not treat as the home or data directory.
const HOME = '/Users/tester';
const DATA_HOME = path.posix.join(HOME, '.kepcup');
const WORKSPACE = path.posix.join(DATA_HOME, 'bots', 'bot_1', 'workspaces', 'conv_1');
const CWD = path.posix.join(HOME, 'project');

function verdict(command: string) {
  return catastrophicCommandVerdict(command, {
    cwd: CWD,
    homeDir: HOME,
    dataHome: DATA_HOME,
    exemptDirs: [WORKSPACE],
    platform: 'darwin',
  });
}

describe('catastrophicCommandVerdict', () => {
  it.each([
    'rm -rf /',
    'rm -rf /*',
    'rm -rf /**',
    'sudo rm -rf /',
    // wrapper 选项值是数字 / 时长时不能把命令名吞掉（曾把 `5` 当成命令名）。
    'nice -n 5 rm -rf /',
    'timeout 10 rm -rf /',
    'timeout 10s rm -rf /etc',
    'timeout 5m sudo rm -rf ~',
    'nohup nice -n -5 rm -rf ~',
    'bash -c "rm -rf /"',
    'bash -lc "rm -rf /"',
    'sh -c "rm -rf /etc"',
    'eval "rm -rf /"',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf ${HOME}',
    'rm -rf ~/',
    'rm -rf ~/.ssh',
    "rm -rf ~/.ssh/*",
    `rm -rf ${HOME}`,
    `rm -rf ${path.posix.join(HOME, 'Downloads')}`,
    `rm -rf ${HOME}/Library`,
    'rm -rf /Users',
    'rm -rf /etc',
    'rm -rf /usr/local',
    'rm -rf /System/Library',
    `rm -rf ${DATA_HOME}/main.db`,
    `rm -rf ${path.posix.join(DATA_HOME, 'bots')}/../config.json`,
    `rm -rf ${path.posix.join(WORKSPACE, '..')}`,
    'mkfs.ext4 /dev/sda1',
    'wipefs -a /dev/disk2',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'chmod -R 777 /',
    'chown -R root:root /',
    'chmod 000 /Users/tester',
    'mv / /tmp/nope',
    'mv ~ /tmp/nope',
    'find / -delete',
    'find ~ -name x -exec rm -rf {} \\;',
    ':(){ :|:& };:',
    'shutdown -h now',
    'reboot',
    'kill -9 -1',
    'echo owned > /etc/passwd',
    ': > /dev/sda',
    'xargs rm -rf',
    `cat ${DATA_HOME}/main.db`,
    `grep -r secret ${DATA_HOME}`,
  ])('blocks %s', (command) => {
    expect(verdict(command).blocked, command).toBe(true);
  });

  it.each([
    'rm -rf ./dist',
    'rm -rf node_modules',
    'rm -rf /tmp/build',
    'rm -rf ~/Downloads/old.zip',
    `rm -rf ${WORKSPACE}`,
    `rm -rf ${path.posix.join(WORKSPACE, 'dist')}`,
    'chmod -R 755 ./scripts',
    'dd if=/dev/zero of=/tmp/zero bs=1 count=1',
    'git status',
    'npm test',
    'cat package.json',
    'echo hi > out.txt',
    'mv ./a ./b',
    'kill -9 12345',
    'ls -la /',
    'find . -name "*.log" -delete',
    'rm -rf ~/Library/Caches/com.example.app',
    'rm -rf /opt/homebrew/Cellar/foo',
    'rsync -a ~/Documents/ /backup',
    'cd ~ && npm test',
  ])('allows %s', (command) => {
    expect(verdict(command).blocked, command).toBe(false);
  });

  it('explains what would be destroyed', () => {
    expect(verdict('rm -rf /').reason).toContain('灾难性命令');
  });
});

describe('catastrophicCommandVerdict (Windows)', () => {
  const winHome = 'C:\\Users\\tester';
  const winData = 'C:\\Users\\tester\\.kepcup';
  const winCwd = 'C:\\work';
  const run = (command: string) =>
    catastrophicCommandVerdict(command, {
      cwd: winCwd,
      homeDir: winHome,
      dataHome: winData,
      platform: 'win32',
    });

  it.each([
    'rd /s /q C:\\',
    'del /f /s /q C:\\Windows\\*',
    'Remove-Item -Recurse -Force C:\\Users',
    'format C:',
    'diskpart',
    // Current-drive root-relative paths (cwd is C:\work): same targets as C:\…
    'rm -rf \\Users\\tester\\.kepcup',
    'rm -rf \\Users\\tester\\.kepcup\\main.db',
    'rm -rf \\Users\\tester\\.kepcup/main.db',
    'rm -rf \\Users\\tester\\.kepcup\\bots\\..\\config.json',
    'rm -rf \\Users\\tester\\.kepcup\\bots/../config.json',
    'rm -rf \\Users\\tester\\.kepcup\\bots\\bot_1\\workspaces',
    'rm -rf \\Users\\tester\\Downloads',
    'rm -rf /Users/tester/Downloads',
    'rm -rf \\Windows',
    'cat \\Users\\tester\\.kepcup\\main.db',
    'cat \\Users\\tester\\.kepcup/main.db',
    'grep -r secret \\Users\\tester\\.kepcup',
  ])('blocks %s', (command) => {
    expect(run(command).blocked, command).toBe(true);
  });

  it.each([
    'rm -rf C:\\work\\dist',
    'rm -rf \\work\\dist',
    'Remove-Item -Force C:\\work\\a.txt',
    'dir',
  ])('allows %s', (command) => {
    expect(run(command).blocked, command).toBe(false);
  });

  it('allows an exempt workspace addressed with a root-relative path', () => {
    const workspace = 'C:\\Users\\tester\\.kepcup\\bots\\bot_1\\workspaces\\conv_1';
    const verdict = catastrophicCommandVerdict(
      'rm -rf \\Users\\tester\\.kepcup\\bots\\bot_1\\workspaces\\conv_1\\dist',
      {
        cwd: winCwd,
        homeDir: winHome,
        dataHome: winData,
        exemptDirs: [workspace],
        platform: 'win32',
      },
    );
    expect(verdict.blocked).toBe(false);
  });
});
