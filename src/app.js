const express = require("express");
const cors = require("cors");
// const routes = require("./routes");
const authRoutes = require('./routes/authRoutes');

require("./config/db"); // Initialize DB connection

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);

module.exports = app;
