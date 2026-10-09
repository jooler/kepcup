import { migrationTargetVersion } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';

/**
 * Versions a migration run that starts after `after` is expected to apply:
 * `after + 1 … latest main migration`. Tests of an old migration use this
 * instead of a literal list so adding a newer migration does not touch them.
 */
export function mainVersionsAfter(after: number): number[] {
  const latest = migrationTargetVersion(migrationsUrl('main'));
  return Array.from({ length: latest - after }, (_, index) => after + 1 + index);
}
