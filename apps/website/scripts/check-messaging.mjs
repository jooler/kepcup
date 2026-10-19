import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(astro|ts|css|mjs)$/.test(name)) files.push(full);
  }
  return files;
}

const en = readFileSync(path.join(srcDir, 'i18n', 'en.ts'), 'utf8');
const zh = readFileSync(path.join(srcDir, 'i18n', 'zh.ts'), 'utf8');
const all = walk(srcDir)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

const failures = [];

function requireIn(label, text, needles) {
  for (const needle of needles) {
    if (!text.includes(needle)) failures.push(`${label} is missing: ${needle}`);
  }
}

requireIn('en', en, [
  'Build a team. Only for you.',
  'Open source is the foundation',
  'does not replace open source',
  'not an in-app Bot',
  'supplement',
  'Grok Bot',
  'Muse / Dot',
  'Rakazo / OpenDots',
  'GPL-3.0',
]);

requireIn('zh', zh, [
  '创建一个团队，只为你服务！',
  '开源是根基',
  '不是来取代开源',
  '不是应用内的 Bot',
  '补充',
  'Grok Bot',
  'Muse / Dot',
  'Rakazo / OpenDots',
  'GPL-3.0',
]);

requireIn('src', all, ['https://github.com/jooler/kepcup/releases']);

if (/opencode/i.test(all)) {
  failures.push('OpenCode must not appear in the marketing site source.');
}

const forbidden = [
  [/instead of open source/i, 'instead of open source'],
  [/replaces open source/i, 'replaces open source'],
  [/replacing open source/i, 'replacing open source'],
  [/取代了开源/, '取代了开源'],
  [/代替开源/, '代替开源'],
];

for (const [pattern, label] of forbidden) {
  if (pattern.test(all)) failures.push(`Forbidden phrasing: ${label}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
