import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PLUGIN_MANIFEST_FILE,
  isReservedPluginNamespace,
  pluginIdSchema,
  pluginNamespaceOf,
} from '@kepcup/shared';
import type { InitPluginArgs } from '../args.js';
import { errorMessage } from '../util.js';

/**
 * `kepcup-app init plugin <dir>`: writes a minimal, immediately valid plugin skeleton
 * (manifest + README + one skill) so a developer can edit and validate without reading
 * KepCup's source.
 */

export class PluginInitError extends Error {}

const USAGE_ERROR = 'Usage error:';

export interface InitPluginIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const SKILL_MD = `---
name: hello
description: A sample skill that shows what a plugin contribution looks like.
---

# Hello

Replace this file with your own skill instructions. KepCup reads the frontmatter
(\`name\`, \`description\`) and exposes the folder to the Bot as an Agent Skill.
`;

function readme(skillName: string): string {
  return `# Plugin skeleton

This directory is a KepCup plugin: a declarative package of skills, connectors, MCP
servers and instance capabilities. A plugin never runs code inside the KepCup process;
local execution is packaged as an embedded \`.mcpb\` bundle or reached over public https.

## What it contributes

- \`skills/${skillName}/SKILL.md\` — one Agent Skill (edit the frontmatter and the body).
- \`plugin.json\` → \`config.fields\` — one example plugin config field. The host builds
  the 「设置」form on the plugin card from it automatically; delete or edit the entry.

\`plugin.json\` is the manifest. Add more contributions there and in this directory.
To provide per-user capability units (mailbox accounts), declare \`instances\` plus a
mail contribution — see the plugin development guide
(\`docs/guides/write-a-plugin.md\` in the KepCup repository) for the full field
reference, per-kind contracts and the install-time consent model.

## Local workflow

\`\`\`sh
kepcup-app validate .
kepcup-app pack .
\`\`\`

Install the folder in KepCup with 「扩展中心 → 已安装 → 从文件夹安装…」 while you
iterate, or install the packed \`.kepcup\` file. Run \`kepcup-app validate\` again before
packing; \`kepcup-app pack\` refuses to produce an archive that has errors.
`;
}

export interface InitPluginResult {
  dir: string;
  id: string;
  files: string[];
}

/** Writes the skeleton; throws {@link PluginInitError} on invalid input or a populated directory. */
export async function initPluginDirectory(options: {
  dir: string;
  id?: string | null;
  name?: string | null;
  force?: boolean;
}): Promise<InitPluginResult> {
  const dir = path.resolve(options.dir);
  const base = path.basename(dir);
  const id = options.id ?? `io.github.your-name/${base.toLowerCase()}`;
  const parsed = pluginIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new PluginInitError(
      `${USAGE_ERROR} "${id}" is not a valid plugin id (expected namespace/name, e.g. io.github.alice/doc-tools).`,
    );
  }
  if (isReservedPluginNamespace(pluginNamespaceOf(id))) {
    throw new PluginInitError(
      `${USAGE_ERROR} the namespace of "${id}" is reserved (com.kepcup and local.kepcup are builtin-only).`,
    );
  }
  let exists = false;
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new PluginInitError(`${USAGE_ERROR} ${dir} is not a directory.`);
    exists = true;
    if (options.force !== true && (await readdir(dir)).length > 0) {
      throw new PluginInitError(
        `${USAGE_ERROR} ${dir} is not empty; pass --force to write into it anyway.`,
      );
    }
  } catch (error) {
    if (error instanceof PluginInitError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PluginInitError(`Cannot read ${dir}: ${errorMessage(error)}`);
    }
  }
  if (!exists) await mkdir(dir, { recursive: true });

  const skillDir = path.join(dir, 'skills', 'hello');
  await mkdir(skillDir, { recursive: true });
  const manifest = {
    format_version: 1,
    id,
    name: options.name ?? base,
    version: '0.1.0',
    description: 'TODO',
    engines: { kepcup: '>=0.4.0' },
    // D105 P5: one example plugin config field — the host builds the card's 「设置」
    // form from `config.fields` automatically. Edit or delete it.
    config: {
      fields: [
        {
          key: 'greetingPrefix',
          type: 'string',
          title: 'Greeting prefix',
          description: 'Example config field shown on the plugin card settings form.',
        },
      ],
    },
    contributions: { skills: [{ dir: 'skills/hello' }] },
  };
  const files = [PLUGIN_MANIFEST_FILE, 'README.md', 'skills/hello/SKILL.md'];
  await writeFile(path.join(dir, PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(dir, 'README.md'), readme('hello'));
  await writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD);
  return { dir, id, files };
}

/** CLI wrapper: prints the result and maps errors to exit code 2 (usage / write failure). */
export async function initPlugin(args: InitPluginArgs, io: InitPluginIo): Promise<number> {
  try {
    const result = await initPluginDirectory(args);
    io.stdout(`Created plugin ${result.id} in ${result.dir}\n`);
    for (const file of result.files) io.stdout(`  ${file}\n`);
    io.stdout('Next: kepcup-app validate . && kepcup-app pack .\n');
    return 0;
  } catch (error) {
    io.stderr(`kepcup-app: ${errorMessage(error)}\n`);
    return 2;
  }
}
