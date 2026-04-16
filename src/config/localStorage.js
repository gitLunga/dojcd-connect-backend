const fs   = require('fs');
const path = require('path');

const LOCAL_ROOT = path.join(__dirname, '..', 'uploads');

console.log(`📦 Storage mode: LOCAL DISK at ${LOCAL_ROOT}`);

// ── uploadFile ────────────────────────────────────────────────────────────────
async function uploadFile(buffer, mimeType, folder, prefix, userId) {
    const ext      = getExtFromMime(mimeType);
    const filename = `${prefix}_${userId}_${Date.now()}${ext}`;
    const relPath  = `${folder}/${filename}`;
    const dir      = path.join(LOCAL_ROOT, folder);

    // ✅ CREATE FOLDER IF IT DOESN'T EXIST
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created directory: ${dir}`);
    }

    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);
    console.log(`✅ Saved locally: uploads/${relPath}`);
    return relPath;
}

// ── downloadFile ──────────────────────────────────────────────────────────────
async function downloadFile(storagePath) {
    const absPath = resolveLocalPath(storagePath);
    if (!fs.existsSync(absPath)) {
        throw new Error(`File not found on disk: ${absPath}`);
    }
    return {
        buffer: fs.readFileSync(absPath),
        contentType: getMimeFromPath(storagePath)
    };
}

// ── getSignedUrl ───────────────────────���──────────────────────────────────────
async function getSignedUrl(storagePath) {
    const encoded = encodeURIComponent(storagePath);
    return `/api/files/${encoded}`;
}

// ── deleteFile ────────────────────────────────────────────────────────────────
async function deleteFile(storagePath) {
    try {
        fs.unlinkSync(resolveLocalPath(storagePath));
        console.log(`✅ Deleted: ${storagePath}`);
    } catch (err) {
        console.warn(`⚠️ Could not delete ${storagePath}:`, err.message);
    }
}

// ── localFileRouter ───────────────────────────────────────────────────────────
const express = require('express');
const localFileRouter = express.Router();

// ✅ FIX: Use .get('*', ...) to capture the ENTIRE encoded path including %2F
localFileRouter.get('*', (req, res) => {
    try {
        // Get the full path after /api/files/
        let encodedPath = req.path;

        // Remove leading slash if present
        if (encodedPath.startsWith('/')) {
            encodedPath = encodedPath.slice(1);
        }

        console.log(`\n📥 [/api/files] Request received`);
        console.log(`   Encoded path: ${encodedPath}`);

        // Decode the URL-encoded path
        const storagePath = decodeURIComponent(encodedPath);
        console.log(`   Decoded path: ${storagePath}`);

        // Resolve to absolute path
        const absPath = resolveLocalPath(storagePath);
        console.log(`   Absolute path: ${absPath}`);

        // Check if file exists
        if (!fs.existsSync(absPath)) {
            console.error(`❌ File not found: ${absPath}`);
            return res.status(404).json({
                success: false,
                message: 'File not found on disk',
                requested: storagePath,
                resolved: absPath
            });
        }

        // Check if it's a file (not directory)
        const stat = fs.statSync(absPath);
        if (!stat.isFile()) {
            console.error(`❌ Not a file: ${absPath}`);
            return res.status(400).json({ success: false, message: 'Not a file' });
        }

        const buffer = fs.readFileSync(absPath);
        const mimeType = getMimeFromPath(storagePath);
        const fileName = path.basename(absPath);

        console.log(`✅ Serving file: ${fileName}`);
        console.log(`   Size: ${buffer.length} bytes`);
        console.log(`   MIME: ${mimeType}\n`);

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
        res.setHeader('Content-Length', buffer.length);
        res.end(buffer);
    } catch (err) {
        console.error(`❌ Error: ${err.message}\n`);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveLocalPath(storagePath) {
    if (!storagePath) throw new Error('Storage path is empty');

    let p = storagePath.startsWith('/') ? storagePath.slice(1) : storagePath;
    if (p.startsWith('uploads/')) p = p.slice('uploads/'.length);

    const resolved = path.join(LOCAL_ROOT, p);

    // Security: prevent directory traversal
    const normalized = path.normalize(resolved);
    if (!normalized.startsWith(path.normalize(LOCAL_ROOT))) {
        throw new Error('Path traversal attempt detected');
    }

    return normalized;
}

function getExtFromMime(mimeType) {
    const map = {
        'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
        'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    };
    return map[mimeType] || '.bin';
}

function getMimeFromPath(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    const map = {
        'pdf': 'application/pdf', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] || 'application/octet-stream';
}

module.exports = { uploadFile, downloadFile, getSignedUrl, deleteFile, getMimeFromPath, localFileRouter };