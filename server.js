const dotenv = require('dotenv');
dotenv.config();

// Refuse to start half-configured (a missing LDAP/Entra setting should fail at boot, not on someone's first sign-in).
require('./src/directory/config').assertDirectoryConfig();

const app = require("./src/app");

const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
