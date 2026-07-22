import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Runs once before any worker starts.
 *
 * Builds the client bundle with `VITE_AUTH_DISABLED=true` baked in (the flag is
 * a Vite build-time constant — `import.meta.env.VITE_AUTH_DISABLED` — so it
 * cannot be toggled at runtime). Every worker's server serves this same static
 * `dist/`, so the build only needs to happen here, once.
 *
 * Set `E2E_SKIP_BUILD=1` to reuse an already-auth-disabled `dist/` (fast local
 * reruns); CI always builds fresh.
 */
async function globalSetup(): Promise<void> {
  const repoRoot = process.cwd();
  const distIndex = path.join(repoRoot, 'dist', 'index.html');

  if (process.env.E2E_SKIP_BUILD === '1' && existsSync(distIndex)) {
    console.log('[e2e] E2E_SKIP_BUILD=1 and dist/ present — skipping client build.');
    return;
  }

  console.log('[e2e] Building client bundle (VITE_AUTH_DISABLED=true) — this runs once...');
  execSync('npm run build:client', {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, VITE_AUTH_DISABLED: 'true' },
  });
  console.log('[e2e] Client build complete.');
}

export default globalSetup;
