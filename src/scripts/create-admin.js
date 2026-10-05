// Creates an Admin account directly in the database.
//
// Public registration for staff no longer exists, so this is how the very first Admin of a
// fresh database is created (after that, Admins add staff in the dashboard).
//
//   npm run create-admin -- --email jane@dojcd.gov.za --first-name Jane --last-name Doe
//   ADMIN_EMAIL=jane@dojcd.gov.za ADMIN_FIRST_NAME=Jane ADMIN_LAST_NAME=Doe npm run create-admin
//
// Prints a random one-time password exactly once. The account must change it at first
// sign-in (the API refuses everything else until it does).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseAdminArgs(argv = [], env = {}) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    }

    const email     = (flags.email || env.ADMIN_EMAIL || '').trim().toLowerCase();
    const firstName = (flags['first-name'] || env.ADMIN_FIRST_NAME || '').trim();
    const lastName  = (flags['last-name']  || env.ADMIN_LAST_NAME  || '').trim();

    if (!firstName || !lastName || !email) {
        throw new Error('Usage: npm run create-admin -- --email <email> --first-name <name> --last-name <name>');
    }
    if (!EMAIL_RE.test(email)) throw new Error(`"${email}" is not a valid email address.`);

    return { email, firstName, lastName };
}

async function createAdmin({ email, firstName, lastName }, { db, bcrypt, generateTempPassword, auditService }) {
    const existing = await db.query(`SELECT 1 FROM operational_user WHERE email = $1`, [email]);
    if (existing.rows.length > 0) {
        throw new Error(`An operational user with the email ${email} already exists.`);
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const { rows: [user] } = await db.query(
        `INSERT INTO operational_user
             (first_name, last_name, email, user_role, password_hash, must_change_password, is_super_admin)
         VALUES ($1, $2, $3, 'Admin', $4, true, true)
         RETURNING op_user_id`,
        [firstName, lastName, email, passwordHash]
    );

    // audit_log.actor_id is NOT NULL: a bootstrap has no acting user, so the new account stands in.
    await auditService.log(db, {
        actorId:    user.op_user_id,
        actorType:  'System',
        action:     'OPERATIONAL_USER_CREATED',
        entityType: 'operational_user',
        entityId:   user.op_user_id,
        newValue:   { email, user_role: 'Admin', via: 'create-admin script' },
    });

    return { opUserId: user.op_user_id, tempPassword };
}

async function main() {
    require('dotenv').config();

    const args = parseAdminArgs(process.argv.slice(2), process.env);
    const db = require('../config/db');
    try {
        const { opUserId, tempPassword } = await createAdmin(args, {
            db,
            bcrypt:               require('bcrypt'),
            generateTempPassword: require('../utils/tempPassword').generateTempPassword,
            auditService:         require('../services/auditService'),
        });
        console.log(`\n✅ Admin created (id ${opUserId}): ${args.email}`);
        console.log(`   One-time password: ${tempPassword}`);
        console.log('   Shown only once — they must change it at first sign-in.\n');
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

module.exports = { parseAdminArgs, createAdmin };
