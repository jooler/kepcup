// ZCode 无 ACP：只检测本机是否装了 ZCode 桌面应用（只看路径是否存在，不读内容、不读用户配置）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function which(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

export function detectZCode() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/ZCode.app', path.join(home, 'Applications', 'ZCode.app'));
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'ZCode'), path.join(local, 'Programs', 'zcode'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ZCode'));
  } else {
    candidates.push('/opt/ZCode', '/opt/zcode', '/usr/lib/zcode', '/usr/share/zcode',
      '/usr/share/applications/zcode.desktop', '/usr/share/applications/ZCode.desktop',
      path.join(home, '.local', 'share', 'applications', 'zcode.desktop'),
      path.join(home, 'Applications', 'ZCode.AppImage'));
  }
  const found = candidates.filter((p) => fs.existsSync(p));
  const onPath = which('zcode');
  return {
    platform: `${process.platform}/${process.arch}`,
    installed: found.length > 0 || Boolean(onPath),
    foundPaths: found,
    zcodeOnPath: onPath,
    searched: candidates,
    note: 'ZCode 无 ACP；设计 28 §9.2 决定只用 system 来源：拉起桌面应用内置 `app-server --stdio`（见 todo 附录 A.1）。本脚本只检测，不启动。',
  };
}
