const { Pool } = require("pg");

console.log("🔧 Using DB connection parameters");

const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'dojcd_new_db',
    connectionTimeoutMillis: 10000,
});

pool.connect()
    .then(client => {
        console.log("✅ PostgreSQL connected successfully");
        client.release(); // always release the test connection
    })
    .catch(err => {
        console.error("❌ Database connection error:", err.message);
    });

// Log pool errors so they don't silently swallow problems
pool.on('error', (err) => {
    console.error('❌ Unexpected DB pool error:', err.message);
});

module.exports = pool;