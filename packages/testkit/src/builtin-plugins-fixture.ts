import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Builtin-plugins directory fixture (D104 P0b): writes a `{dir}/com.kepcup/starter-skills`
 * and/or `{dir}/com.kepcup/connections` tree shaped like the shipped
 * `apps/desktop/resources/plugins/` resources, so tests can inject it via
 * `KEPCUP_BUILTIN_PLUGINS`.
 */

export interface BuiltinFixtureSkill {
  id: string;
  displayName?: string;
  summary?: string;
  section?: string;
  version?: string;
  icon?: string;
  tryIt?: string;
  description?: string;
  skillMd?: string;
}

export interface BuiltinFixtureOptions {
  /** Output directory (created if missing). */
  dir: string;
  skills?: BuiltinFixtureSkill[];
  /** Raw connector entries (exactly what a `server.json` holds, `_meta` included); icons are placeholder svgs. */
  connectors?: Array<Record<string, unknown>>;
}

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

function skillMdOf(skill: BuiltinFixtureSkill): string {
  if (skill.skillMd !== undefined) return skill.skillMd;
  return `---\nname: ${skill.id}\ndescription: ${skill.description ?? `${skill.id} summary`}\n---\n# ${skill.id}\n`;
}

/** Writes the fixture tree and returns the builtin root `dir`. */
export async function buildBuiltinPluginsDir(options: BuiltinFixtureOptions): Promise<string> {
  const root = options.dir;
  await mkdir(path.join(root, 'com.kepcup'), { recursive: true });
  if (options.skills !== undefined) {
    const pluginDir = path.join(root, 'com.kepcup', 'starter-skills');
    const contributions = [];
    for (const skill of options.skills) {
      const skillDir = path.join(pluginDir, 'skills', skill.id);
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), skillMdOf(skill));
      contributions.push({
        dir: `skills/${skill.id}`,
        displayName: skill.displayName ?? skill.id,
        summary: skill.summary ?? `${skill.id} summary`,
        icon: skill.icon ?? 'puzzle',
        section: skill.section ?? 'starter',
        version: skill.version ?? '1.0.0',
        tryIt: skill.tryIt ?? '',
      });
    }
    await writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(
        {
          format_version: 1,
          id: 'com.kepcup/starter-skills',
          name: 'KepCup 入门技能',
          version: '1.0.0',
          description: 'Builtin starter skills fixture',
          contributions: { skills: contributions },
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (options.connectors !== undefined) {
    const pluginDir = path.join(root, 'com.kepcup', 'connections');
    const contributions = [];
    for (const [index, entry] of options.connectors.entries()) {
      const meta = (entry as { _meta?: Record<string, { slug?: unknown; icon?: unknown }> })
        ._meta?.['app.kepcup/connector'];
      const slug = typeof meta?.slug === 'string' ? meta.slug : `connector-${index}`;
      const icon = typeof meta?.icon === 'string' ? meta.icon : `${slug}.svg`;
      const dir = path.join(pluginDir, 'connectors', slug);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'server.json'), JSON.stringify(entry, null, 2) + '\n');
      await writeFile(path.join(dir, icon), ICON_SVG);
      contributions.push({ file: `connectors/${slug}/server.json` });
    }
    await writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(
        {
          format_version: 1,
          id: 'com.kepcup/connections',
          name: 'KepCup 连接应用',
          version: '1.0.0',
          description: 'Builtin connections fixture',
          contributions: { connectors: contributions },
        },
        null,
        2,
      ) + '\n',
    );
  }
  return root;
}
