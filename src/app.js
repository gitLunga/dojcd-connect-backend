const express = require("express");
const app = express();
const cors = require("cors");
const path = require('path');  // ✅ ADD THIS LINE
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const applicationRoutes = require('./routes/Application/applicationRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const approverRoutes = require('./routes/approverRoutes');
const auditRoutes    = require('./routes/auditRoutes');
const slaRoutes      = require('./routes/slaRoutes');

require("./config/db"); // Initialize DB connection


// CORS should be here in the main app file
app.use(cors({
    origin: [
        "https://admin.malcam.co.za",
        "https://client.malcam.co.za",
        "http://localhost:3000"
    ],
    // Allow all origins for development
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));


const storage = require('./config/localStorage');

// Serve local files in dev (no-op in production since router only used locally)
const uploadsDir = path.join(__dirname, 'uploads');
console.log(`📁 Serving static files from: ${uploadsDir}`);

app.use('/api/files', storage.localFileRouter);
app.use('/uploads', express.static(uploadsDir));

// Body Parser
app.use(express.json({limit: '50mb'})); // Increase from default 100kb to 50MB
app.use(express.urlencoded({extended: true, limit: '50mb'}));


//Static files
//app.use('/uploads', require('express').static('uploads'));

//storage serve local files in dev (no-op in production since router only used locally)
//const storage = require('./config/supabaseStorage');
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

app.use('/api/notifications', notificationRoutes);

//device routes
app.use('/api', deviceRoutes);

app.use('/api/approver', approverRoutes);
app.use('/api/audit',   auditRoutes);
app.use('/api/sla',     slaRoutes);

app.get('/api/debug/pool', (req, res) => {
    const pool = require('./config/db');
    res.json({
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
    });
});

module.exports = app;
