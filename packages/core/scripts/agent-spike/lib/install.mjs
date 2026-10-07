// binary 分发：从 ACP Registry 取归档地址 -> 下载 -> sha256 校验 -> 解压。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { REGISTRY_URL } from '../agents.mjs';

export function platformKey() {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (!os || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return `${os}-${arch}`;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`))));
  });
}

export async function loadRegistry({ registryFile, cacheDir }) {
  if (registryFile) return JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  fs.mkdirSync(cacheDir, { recursive: true });
  const cache = path.join(cacheDir, 'registry.json');
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) throw new Error(`registry fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(cache, text);
  return JSON.parse(text);
}

/**
 * @returns {{ command: string, args: string[], install: object }}
 */
export async function installBinary({ registryId, installDir, allowLarge, large, registryFile, log }) {
  const registry = await loadRegistry({ registryFile, cacheDir: installDir });
  const entry = registry.agents.find((a) => a.id === registryId);
  if (!entry) throw new Error(`registry has no agent "${registryId}"`);
  const key = platformKey();
  const dist = entry.distribution?.binary?.[key];
  if (!dist) throw new Error(`registry entry ${registryId}@${entry.version} has no binary for ${key}`);
  if (large && !allowLarge) {
    throw new Error(`${registryId} archive is large (0.5-1 GB): ${dist.archive} -- re-run with --allow-large to download`);
  }
  const target = path.join(installDir, `${registryId}-${entry.version}`);
  const stamp = path.join(target, '.spike-installed.json');
  const info = { registryId, version: entry.version, platform: key, archive: dist.archive, expectedSha256: dist.sha256 ?? null };
  if (!fs.existsSync(stamp)) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const archiveFile = path.join(installDir, path.basename(new URL(dist.archive).pathname));
    log?.(`downloading ${dist.archive}`);
    const t0 = Date.now();
    const res = await fetch(dist.archive, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${dist.archive}`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(archiveFile);
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => hash.update(c));
    await pipeline(body, out);
    info.sha256 = hash.digest('hex');
    info.archiveBytes = fs.statSync(archiveFile).size;
    info.downloadMs = Date.now() - t0;
    if (dist.sha256 && dist.sha256 !== info.sha256) {
      fs.rmSync(archiveFile, { force: true });
      throw new Error(`sha256 mismatch for ${dist.archive}: expected ${dist.sha256}, got ${info.sha256}`);
    }
    info.sha256Verified = Boolean(dist.sha256);
    log?.(`extracting ${archiveFile}`);
    if (archiveFile.endsWith('.zip')) {
      if (process.platform === 'win32') await run('tar', ['-xf', archiveFile, '-C', target]);
      else await run('unzip', ['-q', '-o', archiveFile, '-d', target]);
    } else {
      await run('tar', ['-xf', archiveFile, '-C', target]);
    }
    fs.rmSync(archiveFile, { force: true });
    fs.writeFileSync(stamp, JSON.stringify(info, null, 2));
  } else {
    Object.assign(info, JSON.parse(fs.readFileSync(stamp, 'utf8')), { reused: true });
  }
  const cmdPath = path.resolve(target, dist.cmd);
  if (!fs.existsSync(cmdPath)) throw new Error(`extracted archive has no ${dist.cmd} under ${target}`);
  if (process.platform !== 'win32') fs.chmodSync(cmdPath, 0o755);
  return { command: cmdPath, args: [...(dist.args ?? [])], install: info };
}
