const { Pool } = require("pg");

// DIRECT PostgreSQL CONNECTION (no .env needed)
const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "dojcd_db",   // <-- your database name
    password: "lunga@123",            // <-- your PG password
    port: 5432
});

pool.connect()
    .then(() => console.log("📦 PostgreSQL connected successfully"))
    .catch(err => console.error("❌ Database connection error:", err));

module.exports = pool;
