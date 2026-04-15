// config/pgStorage.js
// File Storage: LOCAL DISK (VPS) + PostgreSQL metadata tracking
// Files are saved to disk; paths + metadata are recorded in PostgreSQL

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── PostgreSQL Connection ─────────────────────────────────────────────────────
const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

pool.on('error', (err) => {
    console.error('❌ PostgreSQL pool error:', err.message);
});

// ── Config ────────────────────────────────────────────────────────────────────
const LOCAL_ROOT = path.join(__dirname, '..', 'uploads');
const BASE_URL   = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

console.log(`📦 Storage mode: LOCAL DISK (PostgreSQL metadata)`);
console.log(`📁 Upload root: ${LOCAL_ROOT}`);

// ── Ensure uploads table exists ───────────────────────────────────────────────
async function ensureStorageTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS storage_files (
            id           SERIAL PRIMARY KEY,
            storage_path TEXT        NOT NULL UNIQUE,
            original_name TEXT,
            mime_type    TEXT,
            file_size    INTEGER,
            folder       TEXT,
            user_id      TEXT,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    console.log('✅ storage_files table ready');
}

// Call once at startup
ensureStorageTable().catch(err =>
    console.error('❌ Failed to create storage_files table:', err.message)
);

// ── uploadFile ────────────────────────────────────────────────────────────────
// Saves file to disk and records metadata in PostgreSQL
// Returns: relative storage path (e.g. "avatars/avatar_123_1234567890.jpg")
async function uploadFile(buffer, mimeType, folder, prefix, userId) {
    const ext      = getExtFromMime(mimeType);
    const filename = `${prefix}_${userId}_${Date.now()}${ext}`;
    const relPath  = `${folder}/${filename}`;
    const absDir   = path.join(LOCAL_ROOT, folder);
    const absPath  = path.join(absDir, filename);

    // Save to disk
    if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
    fs.writeFileSync(absPath, buffer);
    console.log(`✅ Saved to disk: uploads/${relPath}`);

    // Record metadata in PostgreSQL
    try {
        await pool.query(
            `INSERT INTO storage_files (storage_path, mime_type, file_size, folder, user_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (storage_path) DO UPDATE
             SET mime_type = EXCLUDED.mime_type,
                 file_size = EXCLUDED.file_size,
                 created_at = NOW()`,
            [relPath, mimeType, buffer.length, folder, String(userId)]
        );
        console.log(`✅ Metadata saved to PostgreSQL: ${relPath}`);
    } catch (err) {
        // Non-fatal: file is on disk, just metadata failed
        console.warn(`⚠️ Metadata insert failed (file still saved): ${err.message}`);
    }

    return relPath;
}

// ── downloadFile ──────────────────────────────────────────────────────────────
// Reads file from disk, returns { buffer, contentType }
async function downloadFile(storagePath) {
    const absPath = resolveLocalPath(storagePath);

    if (!fs.existsSync(absPath)) {
        throw new Error(`File not found on disk: ${absPath}`);
    }

    // Optionally enrich mime type from PostgreSQL metadata
    let contentType = getMimeFromPath(storagePath);
    try {
        const { rows } = await pool.query(
            'SELECT mime_type FROM storage_files WHERE storage_path = $1',
            [normaliseStoragePath(storagePath)]
        );
        if (rows.length > 0 && rows[0].mime_type) {
            contentType = rows[0].mime_type;
        }
    } catch (_) { /* fall back to path-based mime */ }

    return { buffer: fs.readFileSync(absPath), contentType };
}

// ── getSignedUrl ──────────────────────────────────────────────────────────────
// Returns a backend proxy URL (no expiry needed — auth is handled by your routes)
async function getSignedUrl(storagePath, expiresIn = 300) {
    const encoded = encodeURIComponent(normaliseStoragePath(storagePath));
    return `${BASE_URL}/api/files/${encoded}`;
}

// ── deleteFile ────────────────────────────────────────────────────────────────
// Removes file from disk and cleans up PostgreSQL metadata
async function deleteFile(storagePath) {
    const normalised = normaliseStoragePath(storagePath);
    const absPath    = resolveLocalPath(storagePath);

    // Delete from disk
    try {
        if (fs.existsSync(absPath)) {
            fs.unlinkSync(absPath);
            console.log(`🗑️  Deleted from disk: ${normalised}`);
        }
    } catch (err) {
        console.warn(`⚠️ Could not delete file from disk: ${err.message}`);
    }

    // Remove metadata from PostgreSQL
    try {
        await pool.query(
            'DELETE FROM storage_files WHERE storage_path = $1',
            [normalised]
        );
        console.log(`🗑️  Metadata removed from PostgreSQL: ${normalised}`);
    } catch (err) {
        console.warn(`⚠️ Could not remove metadata from PostgreSQL: ${err.message}`);
    }
}

// ── listFiles ─────────────────────────────────────────────────────────────────
// Bonus: list all files for a user or folder from PostgreSQL
async function listFiles({ userId, folder } = {}) {
    let query  = 'SELECT * FROM storage_files WHERE 1=1';
    const params = [];

    if (userId) {
        params.push(String(userId));
        query += ` AND user_id = $${params.length}`;
    }
    if (folder) {
        params.push(folder);
        query += ` AND folder = $${params.length}`;
    }

    query += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(query, params);
    return rows;
}

// ── localFileRouter ───────────────────────────────────────────────────────────
// Mount in app.js:  app.use('/api/files', storage.localFileRouter);
// Serves files directly from disk
const express       = require('express');
const localFileRouter = express.Router();

localFileRouter.get('/:encodedPath', async (req, res) => {
    try {
        const storagePath = decodeURIComponent(req.params.encodedPath);
        const absPath     = resolveLocalPath(storagePath);

        if (!fs.existsSync(absPath)) {
            return res.status(404).json({ success: false, message: 'File not found on disk' });
        }

        // Try to get mime type from PostgreSQL first
        let contentType = getMimeFromPath(storagePath);
        try {
            const { rows } = await pool.query(
                'SELECT mime_type FROM storage_files WHERE storage_path = $1',
                [normaliseStoragePath(storagePath)]
            );
            if (rows.length > 0 && rows[0].mime_type) contentType = rows[0].mime_type;
        } catch (_) { /* fall back to path-based mime */ }

        const buffer = fs.readFileSync(absPath);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(storagePath)}"`);
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(buffer);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveLocalPath(storagePath) {
    let p = normaliseStoragePath(storagePath);
    return path.join(LOCAL_ROOT, p);
}

function normaliseStoragePath(storagePath) {
    let p = storagePath.startsWith('/') ? storagePath.slice(1) : storagePath;
    if (p.startsWith('uploads/')) p = p.slice('uploads/'.length);
    return p;
}

function getExtFromMime(mimeType) {
    const map = {
        'application/pdf':   '.pdf',
        'image/jpeg':        '.jpg',
        'image/jpg':         '.jpg',
        'image/png':         '.png',
        'image/gif':         '.gif',
        'image/webp':        '.webp',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    };
    return map[mimeType] || '.bin';
}

function getMimeFromPath(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    const map = {
        'pdf':  'application/pdf',
        'jpg':  'image/jpeg',
        'jpeg': 'image/jpeg',
        'png':  'image/png',
        'gif':  'image/gif',
        'webp': 'image/webp',
        'doc':  'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] || 'application/octet-stream';
}

module.exports = {
    uploadFile,
    downloadFile,
    getSignedUrl,
    deleteFile,
    listFiles,
    getMimeFromPath,
    IS_LOCAL: true,
    localFileRouter,
    pool,   // export pool in case other modules need direct DB access
};
