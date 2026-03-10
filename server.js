// ===== ENVIRONMENT SETUP - MUST BE FIRST =====
const path = require('path');
const dotenv = require('dotenv');

// Set process.env.NODE_ENV explicitly
if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'development';
}

// Decide which env file to load
let envFile = '.env';

// Use .env.local for development
if (process.env.NODE_ENV === 'development') {
    envFile = '.env.local';
}

// Load the appropriate .env file
console.log(`📁 Loading environment from: ${envFile}`);
const result = dotenv.config({ path: path.join(__dirname, envFile) });

if (result.error) {
    console.log(`⚠️  Could not load ${envFile}, using process.env`);
} else {
    console.log(`✅ Loaded ${envFile}`);
}

// ===== REST OF YOUR APP =====
const app = require("./src/app");

const PORT = process.env.PORT || 5000;

console.log("🚀 Starting server...");
console.log(`🌍 NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`📦 DATABASE_URL: ${process.env.DATABASE_URL ? 'Set ✓' : 'Not set ✗'}`);

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});