// Pulls the people in the directory's staff groups into the system (same as the dashboard's sync).
//
//   npm run sync-directory -- --dry-run     show what would change, change nothing
//   npm run sync-directory                  create/update staff, switch off group-granted staff who left
//   npm run sync-directory -- --force       proceed even if the directory returned nobody
//
// Needs AUTH_PROVIDER=ldap or entra (see docs/directory-sign-in.md). Safe to run from cron.

function parseSyncArgs(argv = []) {
    const known = ['--dry-run', '--force'];
    const unknown = argv.filter((a) => !known.includes(a));
    if (unknown.length > 0) throw new Error(`Unknown option ${unknown[0]}. Usage: npm run sync-directory -- [--dry-run] [--force]`);
    return { dryRun: argv.includes('--dry-run'), force: argv.includes('--force') };
}

async function main() {
    require('dotenv').config();
    const options = parseSyncArgs(process.argv.slice(2));

    const { assertDirectoryConfig } = require('../directory/config');
    const cfg = assertDirectoryConfig();
    if (cfg.provider === 'local') throw new Error('Directory sync needs AUTH_PROVIDER=ldap or AUTH_PROVIDER=entra.');

    const db = require('../config/db');
    try {
        const result = await require('../directory').getDirectoryAuth().syncDirectory(options);
        console.log(`\n${result.dryRun ? '🔍 Dry run: nothing was changed.' : '✅ Directory sync complete.'}`);
        console.log(`   staff created: ${result.created}   updated: ${result.updated}   switched off: ${result.revoked}   clients pre-created: ${result.clientsProvisioned}`);
        result.errors.forEach((e) => console.log(`   ⚠️  ${e.account}: ${e.message}`));
        console.log('');
        if (result.errors.length > 0) process.exitCode = 2;
    } finally {
        await db.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`\n❌ ${err.message}\n`);
        process.exit(1);
    });
}

module.exports = { parseSyncArgs };
