const { Pool } = require("pg");

let pool;

if (process.env.NODE_ENV === 'production') {
    console.log("🔧 Configuring for PRODUCTION database");
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });
} else {
    console.log("🔧 Configuring for DEVELOPMENT database");
    pool = new Pool({
        user: "postgres",
        host: "localhost",
        database: "dojcd_db",
        password: "lunga@123",
        port: 5432,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });
}

// ✅ Test connection WITHOUT leaking — must release the client
pool.connect()
    .then(client => {
        console.log("✅ PostgreSQL connected successfully");
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        client.release(); // ← this was missing — was permanently consuming 1 slot
    })
    .catch(err => {
        console.error("❌ Database connection error:", err.message);
        console.error("🔍 Check your DATABASE_URL or local credentials");
    });

module.exports = pool;