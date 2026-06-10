const { Pool } = require("pg");

console.log("🔧 Using DB connection parameters");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "dojcd_new_db",
  // ✅ Add these
  max: 10, // max pool size
  min: 1, // keep 1 connection warm
  idleTimeoutMillis: 30000, // release idle connections after 30s
  connectionTimeoutMillis: 10000, // timeout waiting for a connection
  allowExitOnIdle: true, // let the process exit cleanly when idle
});

pool
  .connect()
  .then((client) => {
    console.log("✅ PostgreSQL connected successfully");
    client.release(); // always release the test connection
  })
  .catch((err) => {
    console.error("❌ Database connection error:", err.message);
  });

// Log pool errors so they don't silently swallow problems
pool.on("error", (err) => {
  console.error("❌ Unexpected DB pool error:", err.message);
});

process.on("SIGINT", () => pool.end().then(() => process.exit(0)));
process.on("SIGTERM", () => pool.end().then(() => process.exit(0)));

module.exports = pool;
