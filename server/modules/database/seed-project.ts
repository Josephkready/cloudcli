/**
 * Registers one project row directly in the database, for test fixtures.
 *
 *   DATABASE_PATH=/path/auth.db tsx --tsconfig server/tsconfig.json \
 *     server/modules/database/seed-project.ts <projectPath> [displayName]
 *
 * The e2e harness (e2e/fixtures.ts) used to seed its project through
 * `POST /api/projects/create-project`. That endpoint went away with the
 * project-creation wizard, so the harness seeds the row the same way session
 * sync does when it discovers a project: `projectsDb.createProjectPath`.
 * Run it before the server starts; the server's own startup re-runs the
 * (idempotent) schema init.
 */
import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';

const [projectPath, displayName] = process.argv.slice(2);
if (!projectPath) {
  console.error('usage: seed-project.ts <projectPath> [displayName]');
  process.exit(2);
}

await initializeDatabase();
const result = projectsDb.createProjectPath(projectPath, displayName ?? null);
closeConnection();

if (result.outcome !== 'created') {
  console.error(`seed-project: expected a fresh project, got ${result.outcome} for ${projectPath}`);
  process.exit(1);
}
