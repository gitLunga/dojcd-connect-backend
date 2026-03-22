const { Pool } = require('pg');

// Use the CORRECT connection string
const connectionString = 'postgresql://postgres.okdaiwvfafcfduvjzbhg:DeptGov2026@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';

console.log('🔍 Testing connection to:', connectionString.replace(/:[^:@]+@/, ':****@'));

const pool = new Pool({
    connectionString: connectionString,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Connection failed:', err.message);
        console.error('Full error:', err);
    } else {
        console.log('✅ Connected! Server time:', res.rows[0].now);
    }
    process.exit();
});