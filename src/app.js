const express = require("express");
const cors = require("cors");
const authRoutes = require('./routes/authRoutes');

require("./config/db"); // Initialize DB connection

const app = express();
app.use(express.json({ limit: '50mb' })); // Increase from default 100kb to 50MB
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS should be here in the main app file
app.use(cors({
    origin: "*", // Allow all origins for development
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

app.use(express.json());

// Add a test endpoint at the root
app.get('/api/test', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Backend is connected and working!',
        timestamp: new Date().toISOString()
    });
});

app.use('/api/auth', authRoutes);

module.exports = app;