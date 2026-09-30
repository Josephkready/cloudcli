/**
 * Database connection management.
 *
 * Owns the single SQLite connection used across all repositories.
 * Handles path resolution, directory creation, legacy database migration,
 * and eager app_config bootstrap so the auth middleware can read the
 * JWT secret before the full schema is applied.
 *
 * Consumers should never create their own Database instance — they use
 * `getConnection()` to obtain the shared singleton.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** SQLite's special path for a private, throwaway, in-memory database. */
export const IN_MEMORY_DATABASE_PATH = ':memory:';

/**
 * The server's default location, set by load-env.js when DATABASE_PATH is not
 * configured. Duplicated rather than imported: importing load-env.js would run
 * its side effects (reading .env, defaulting DATABASE_PATH) in every consumer.
 */
const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');

/**
 * Resolves the database file path.
 *
 * The server always has DATABASE_PATH: load-env.js sets it from .env or to
 * ~/.cloudcli/auth.db before anything opens the database. It is only unset when
 * a module reaches the database without going through the server entry point —
 * a test or a script that imports a repository (or `middleware/auth.js`, which
 * reads the JWT secret at import time). Those get a throwaway in-memory
 * database. This used to fall back to `<repo>/database/auth.db`, which created a
 * real database inside the checkout that the legacy migration below then
 * copied into every fresh DATABASE_PATH.
 */
function resolveDatabasePath(): string {
  return process.env.DATABASE_PATH || IN_MEMORY_DATABASE_PATH;
}

/**
 * Resolves the legacy database path: `database/auth.db` in the install root.
 * Used only for the one-time migration to the default external location.
 */
function resolveLegacyDatabasePath(): string {
  const serverDir = path.resolve(__dirname, '..', '..', '..');
  return path.join(serverDir, 'database', 'auth.db');
}

// ---------------------------------------------------------------------------
// Directory & migration helpers
// ---------------------------------------------------------------------------

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created database directory:', dir);
  }
}

/**
 * Whether to copy a legacy install-directory auth.db into `targetPath`.
 *
 * Only for the upgrade it exists for: the database moved from the install
 * directory to the default ~/.cloudcli/auth.db, which does not exist yet. An
 * explicitly configured DATABASE_PATH (prod's /var/lib/cloudcli, the e2e and
 * bench fixtures' temp dirs) is never seeded from whatever database happens to
 * sit in the checkout, and an in-memory database cannot be a copy target at all
 * (copying to the path ':memory:' wrote a real file by that name into the cwd).
 */
export function shouldMigrateLegacyDatabase(
  targetPath: string,
  legacyPath: string,
  defaultPath: string = DEFAULT_DATABASE_PATH,
  exists: (filePath: string) => boolean = fs.existsSync,
): boolean {
  if (targetPath === IN_MEMORY_DATABASE_PATH) return false;
  if (path.resolve(targetPath) !== path.resolve(defaultPath)) return false;
  if (path.resolve(targetPath) === path.resolve(legacyPath)) return false;
  return !exists(targetPath) && exists(legacyPath);
}

/**
 * If the database was moved to the default external location (~/.cloudcli/)
 * but the user still has a legacy auth.db inside the install directory,
 * copy it to the new location as a one-time migration.
 */
function migrateLegacyDatabase(targetPath: string): void {
  const legacyPath = resolveLegacyDatabasePath();

  if (!shouldMigrateLegacyDatabase(targetPath, legacyPath)) {
    // A fresh explicit DATABASE_PATH is not seeded from the checkout's database,
    // but say so: an operator moving an old install to a custom path should copy
    // it deliberately rather than silently start from an empty database.
    if (
      path.resolve(targetPath) !== path.resolve(legacyPath)
      && !fs.existsSync(targetPath)
      && fs.existsSync(legacyPath)
    ) {
      console.warn('Legacy database left in place: DATABASE_PATH is a new, non-default location', {
        legacy: legacyPath,
        databasePath: targetPath,
      });
    }
    return;
  }

  try {
    fs.copyFileSync(legacyPath, targetPath);
    console.log('Migrated legacy database', { from: legacyPath, to: targetPath });


    // copy the write-ahead log and shared memory files (auth.db-wal, auth.db-shm) if they exist, to preserve any uncommitted transactions
    for (const suffix of ['-wal', '-shm']) {
      const src = legacyPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, targetPath + suffix);
      }
    }
  } catch (err: any) {
    console.error('Could not migrate legacy database', { error: err.message });
  }
}


// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

let instance: Database.Database | null = null;
let warnedInMemory = false;

/**
 * Returns the shared database connection, creating it on first call.
 *
 * The first invocation:
 *   1. Resolves the target database path
 *   2. Ensures the parent directory exists
 *   3. Migrates from the legacy install-directory path if needed
 *   4. Opens the SQLite connection
 *   5. Eagerly creates the app_config table (auth reads JWT secret at import time)
 *   6. Logs the database location
 */
export function getConnection(): Database.Database {
  if (instance) return instance;

  const dbPath = resolveDatabasePath();

  if (dbPath !== IN_MEMORY_DATABASE_PATH) {
    ensureDatabaseDirectory(dbPath);
    migrateLegacyDatabase(dbPath);
  } else if (!process.env.DATABASE_PATH && !warnedInMemory) {
    // Expected in tests. Anywhere else it means an entry point skipped load-env.js
    // and nothing it writes will survive the process, so say it once.
    warnedInMemory = true;
    console.warn('DATABASE_PATH is not set: using an in-memory database (nothing will persist)');
  }

  instance = new Database(dbPath);

  // WAL mode lets readers and the writer proceed concurrently and only
  // fsyncs the (small) WAL file instead of rewriting/fsyncing a full
  // rollback journal on every commit — every single-row write in the app
  // (active_runs inserts/deletes, api_keys.last_used touches, session
  // renames, etc.) currently pays one rollback-journal fsync each.
  // `synchronous = NORMAL` is the documented-safe pairing with WAL (a hard
  // power-loss can lose the last commit but never corrupts the DB).
  // `busy_timeout` avoids SQLITE_BUSY if a second process (e.g. the
  // `cloudcli usage` CLI) touches the DB concurrently.
  //
  // Skipped for in-memory databases (tests) — WAL is a no-op there and
  // better-sqlite3 warns/no-ops on the pragma anyway.
  if (dbPath !== IN_MEMORY_DATABASE_PATH) {
    instance.pragma('journal_mode = WAL');
    instance.pragma('synchronous = NORMAL');
    instance.pragma('busy_timeout = 5000');
  }

  // app_config must exist immediately — the auth middleware reads
  // the JWT secret at module-load time, before initializeDatabase() runs.
  instance.exec(APP_CONFIG_TABLE_SCHEMA_SQL);

  return instance;
}

/**
 * Returns the resolved database file path without opening a connection.
 * Useful for diagnostics and CLI status commands.
 */
export function getDatabasePath(): string {
  return resolveDatabasePath();
}

/**
 * Closes the database connection and clears the singleton.
 * Primarily used for graceful shutdown or testing.
 */
export function closeConnection(): void {
  if (instance) {
    try {
      // In WAL mode, committed writes can live in the -wal sidecar file
      // rather than the main db file until a checkpoint happens. A
      // TRUNCATE checkpoint flushes everything back into the main file (and
      // empties/removes the -wal file) so that a raw file copy of the main
      // db taken right after a graceful shutdown reflects the latest state
      // without also needing the -wal/-shm files. This does NOT make
      // concurrent (mid-uptime) raw-file backups of a WAL-mode db safe —
      // see the note in connection.test.ts and the PR description for why
      // a live backup still needs `.backup()`/VACUUM INTO instead.
      instance.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err: any) {
      console.error('Could not checkpoint WAL before closing database', { error: err.message });
    }
    instance.close();
    instance = null;
    console.log('Database connection closed');
  }
}
