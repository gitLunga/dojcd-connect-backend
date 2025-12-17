const { Pool } = require("pg");

// DIRECT PostgreSQL CONNECTION (no .env needed)
const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "dojc_db",   // <-- your database name
    password: "Ngangotshani@3",            // <-- your PG password
    port: 5432
});

pool.connect()
    .then(() => console.log("📦 PostgreSQL connected successfully"))
    .catch(err => console.error("❌ Database connection error:", err));

module.exports = pool;
