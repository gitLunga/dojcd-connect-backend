// Pulls people from the directory into the system (same as the dashboard's sync).
//
//   npm run sync-directory -- --dry-run     show what would change, change nothing
//   npm run sync-directory                  create/update staff, switch off group-granted staff who left
//                                           (and the clients group's members, when AD_GROUP_CLIENTS is set)
//   npm run sync-directory -- --clients     only clients: the clients group, or everyone else in the directory
//   npm run sync-directory -- --all         staff and clients
//   npm run sync-directory -- --force       proceed even if the directory returned nobody
//
// Needs AUTH_PROVIDER=ldap or entra (see docs/directory-sign-in.md). Safe to run from cron.

function parseSyncArgs(argv = []) {
    const known = ['--dry-run', '--force', '--clients', '--all'];
    const unknown = argv.filter((a) => !known.includes(a));
    if (unknown.length > 0) {
        throw new Error(`Unknown option ${unknown[0]}. Usage: npm run sync-directory -- [--dry-run] [--force] [--clients | --all]`);
    }
    if (argv.includes('--clients') && argv.includes('--all')) throw new Error('Use either --clients or --all, not both.');
    const scope = argv.includes('--clients') ? 'clients' : argv.includes('--all') ? 'all' : undefined;
    return { dryRun: argv.includes('--dry-run'), force: argv.includes('--force'), ...(scope ? { scope } : {}) };
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
        if (result.scope !== 'clients') {
            console.log(`   staff     created: ${result.created}   updated: ${result.updated}   switched off: ${result.revoked}`);
        }
        if (result.clients) {
            const c = result.clients;
            console.log(`   clients   created: ${c.created}   linked to an existing account: ${c.linked}   updated: ${c.updated}   (from ${c.source}: ${c.found} found)`);
            console.log(`             skipped: ${c.skippedStaff} staff, ${c.skippedDeactivated} deactivated, ${c.skippedNoEmail} without an email`);
        }
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
