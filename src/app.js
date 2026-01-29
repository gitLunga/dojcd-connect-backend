const express = require("express");
const cors = require("cors");
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const applicationRoutes = require('./routes/Application/applicationRoutes');

require("./config/db"); // Initialize DB connection

const app = express();

// CORS should be here in the main app file
app.use(cors({
    origin: "*", // Allow all origins for development
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

app.use(express.json({ limit: '50mb' })); // Increase from default 100kb to 50MB
app.use(express.urlencoded({ extended: true, limit: '50mb' }));



app.use(express.json());

// Add a test endpoint at the root
app.get('/api/test', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Backend is connected and working!',
        timestamp: new Date().toISOString()
    });
});

//authorization routes
app.use('/api/auth', authRoutes);

//admin routes
app.use('/api/admin', adminRoutes);

//application routes
app.use('/api/applications', applicationRoutes);

module.exports = app;