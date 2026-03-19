const { Pool } = require("pg");

let pool;

if (process.env.NODE_ENV === 'production') {
    // PRODUCTION: Use DATABASE_URL from Render
    console.log("🔧 Configuring for PRODUCTION database");
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false  // Required for Supabase
        }
    });
} else {
    // DEVELOPMENT: Local PostgreSQL
    console.log("🔧 Configuring for DEVELOPMENT database");
    pool = new Pool({
        user: "postgres",
        host: "localhost",
        database: "dojcd_db",
        password: "Ngangotshani@3",
        port: 5432
    });
}

// Test the connection
pool.connect()
    .then(() => {
        console.log("✅ PostgreSQL connected successfully");
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    })
    .catch(err => {
        console.error("❌ Database connection error:", err.message);
        console.error("🔍 Check your DATABASE_URL or local credentials");
    });

module.exports = pool;