const { Pool } = require("pg");

//console.log("🔧 Using DATABASE_URL for DB connection");
console.log("🔧 Using DB connection parameters");


const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'dojcd_new_db',
    connectionTimeoutMillis: 10000,
});

console.log("🔧 Using DB connection parameters (host/user/password)");

//const isProduction = process.env.NODE_ENV === "production";
pool.connect()
    .then(client => {
        console.log("✅ PostgreSQL connected successfully");
        client.release();
    })
    .catch(err => {
        console.error("❌ Database connection error:", err.message);
    });

module.exports = pool;
