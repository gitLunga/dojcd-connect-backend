require('dotenv').config();
const { Pool } = require('pg');

console.log('Testing database connection...');
console.log('Host:', process.env.DB_HOST);
console.log('User:', process.env.DB_USER);
console.log('Database:', process.env.DB_NAME);
console.log('Password exists:', !!process.env.DB_PASSWORD);

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

pool.connect()
    .then(client => {
        console.log('✅ Database connected successfully!');
        client.release();
        process.exit(0);
    })
    .catch(e => {
        console.error('❌ Database connection failed:', e.message);
        process.exit(1);
    });
