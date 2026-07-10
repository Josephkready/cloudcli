import { getConnection } from "@/modules/database/connection.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";
import { userDb } from "@/modules/database/repositories/users.js";

/**
 * When auth is disabled, every request resolves to the single default user via
 * userDb.getFirstUser(). Seed that user once so req.user (and the users(id)
 * foreign keys other tables depend on) is always populated. The stored password
 * hash is a non-usable placeholder — there is no login path in this mode.
 *
 * The flag is read from the environment at call time (rather than the
 * import-frozen AUTH_DISABLED constant) because initializeDatabase runs once at
 * startup, and reading it live keeps the seeding decision testable.
 */
const seedDefaultUser = () => {
    const authDisabled = process.env.VITE_AUTH_DISABLED === 'true';
    if (!authDisabled || userDb.hasUsers()) {
        return;
    }
    userDb.createUser('local', 'auth-disabled-no-login');
    console.log('Seeded default user for auth-disabled mode');
};

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        runMigrations(db);
        seedDefaultUser();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
