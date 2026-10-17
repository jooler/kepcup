/**
 * Project module registry (D92, docs/design/41-project-team.md §10.1). Pure
 * data + predicates shared by core (host enforcement) and the renderer
 * (progressive disclosure); labels live in i18n (`project.module.<id>`).
 */

export const PROJECT_MODULE_IDS = ['chat', 'wiki', 'board', 'okr', 'calendar'] as const;
export type ProjectModuleId = (typeof PROJECT_MODULE_IDS)[number];

export type ProjectModuleWrite = 'members' | 'lead' | 'owner';

export interface ProjectModuleDescriptor {
  id: ProjectModuleId;
  status: 'available' | 'planned';
  /** 'members' 全员可写；'lead' 仅负责人；'owner' 条目级：创建者，或负责人 / 用户。用户恒可写。读权限恒为项目组全员。 */
  write: ProjectModuleWrite;
}

export const PROJECT_MODULES: readonly ProjectModuleDescriptor[] = [
  { id: 'chat', status: 'available', write: 'members' },
  { id: 'wiki', status: 'available', write: 'owner' },
  { id: 'board', status: 'planned', write: 'lead' },
  { id: 'okr', status: 'planned', write: 'lead' },
  { id: 'calendar', status: 'planned', write: 'lead' },
];

export type ProjectActor = 'user' | 'lead' | 'member';

const MODULE_BY_ID = new Map<ProjectModuleId, ProjectModuleDescriptor>(
  PROJECT_MODULES.map((module) => [module.id, module]),
);

/** Module-level write permission (the user is always allowed). */
export function canWriteModule(moduleId: ProjectModuleId, actor: ProjectActor): boolean {
  const module = MODULE_BY_ID.get(moduleId);
  if (module === undefined) return false;
  if (actor === 'user') return true;
  if (actor === 'lead') return true;
  // member: only modules every member may write; entry-level writes in 'owner'
  // modules are decided by canManageEntry.
  return module.write === 'members';
}

/**
 * Entry-level management (write === 'owner' modules, e.g. a wiki source): the
 * user and the lead manage everything; a member only entries it created.
 * Other modules fall back to the module-level answer.
 */
export function canManageEntry(
  moduleId: ProjectModuleId,
  actor: ProjectActor,
  createdBy: { kind: 'user' | 'bot'; id?: string },
  actorBotId?: string,
): boolean {
  const module = MODULE_BY_ID.get(moduleId);
  if (module === undefined) return false;
  if (module.write !== 'owner') return canWriteModule(moduleId, actor);
  if (actor === 'user' || actor === 'lead') return true;
  return createdBy.kind === 'bot' && createdBy.id === actorBotId;
}
