// A throwaway PostgreSQL database for tests that need the real schema.
//
// Enabled by TEST_PG_HOST (plus TEST_PG_PORT / TEST_PG_USER / TEST_PG_PASSWORD). It builds the schema the
// same way a new deployment does (dojc_db.sql, then the migrations in order) and drops it afterwards.
// Call useTestDatabase() BEFORE requiring anything under src/: the pool reads its settings at require time.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const HAVE_DB = !!process.env.TEST_PG_HOST;

// Files that may fail on a fresh database (legacy renames, already-applied changes) are tolerated.
const SCHEMA_FILES = [
    ['dojc_db.sql'], ['migrations/001_fix_schema.sql', true], ['migrations/002_add_department_to_operational_user.sql', true],
    ['migrations/003_add_password_reset_token.sql', true], ['migrations/004_inventory_and_resubmit.sql', true],
    ['migrations/005_rename_s3_path_to_file_path.sql', true], ['migrations/006_returns_delegation_budget.sql', true],
    ['migrations/007_client_user_deactivated_status.sql', true], ['src/scripts/migrate-department-isolation.sql', true],
    ['migrations/008_seed_doj_departments.sql', true], ['migrations/009_directory_auth.sql'],
];

const pgConfig = (database) => ({
    host: process.env.TEST_PG_HOST, port: parseInt(process.env.TEST_PG_PORT || '5432', 10),
    user: process.env.TEST_PG_USER || 'postgres', password: process.env.TEST_PG_PASSWORD, database,
});

function useTestDatabase() {
    const name = `dojcd_test_${crypto.randomBytes(4).toString('hex')}`;
    if (HAVE_DB) {
        process.env.DB_HOST = process.env.TEST_PG_HOST;
        process.env.DB_PORT = process.env.TEST_PG_PORT || '5432';
        process.env.DB_USER = process.env.TEST_PG_USER || 'postgres';
        process.env.DB_PASSWORD = process.env.TEST_PG_PASSWORD;
        process.env.DB_NAME = name;
    }
    process.env.JWT_SECRET = 'directory-test-secret-that-is-long-enough-123';
    process.env.NODE_ENV = 'test';

    async function applySql(file, tolerate) {
        const { Client } = require('pg');
        const c = new Client(pgConfig(name));
        await c.connect();
        try {
            await c.query(fs.readFileSync(path.join(ROOT, file), 'utf8'));
        } catch (err) {
            if (!tolerate) throw new Error(`${file}: ${err.message}`);
        } finally { await c.end(); }
    }

    return {
        name,
        enabled: HAVE_DB,
        skip: !HAVE_DB && 'set TEST_PG_HOST to run',
        async create() {
            const { Client } = require('pg');
            const admin = new Client(pgConfig('postgres'));
            await admin.connect();
            await admin.query(`CREATE DATABASE ${name}`);
            await admin.end();
            for (const [file, tolerate] of SCHEMA_FILES) await applySql(file, tolerate);
        },
        async drop(pool) {
            if (!HAVE_DB) return;
            if (pool) await pool.end();
            const { Client } = require('pg');
            const admin = new Client(pgConfig('postgres'));
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
            await admin.end();
        },
    };
}

module.exports = { useTestDatabase };
