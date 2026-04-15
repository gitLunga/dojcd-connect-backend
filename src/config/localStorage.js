const fs   = require('fs');
const path = require('path');

const LOCAL_ROOT = path.join(__dirname, '..', 'uploads');

console.log(`📦 Storage mode: LOCAL DISK`);

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

// ── getSignedUrl ──���───────────────────────────────────────────────────────────
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

localFileRouter.get('/:encodedPath', (req, res) => {
    try {
        const storagePath = decodeURIComponent(req.params.encodedPath);
        const absPath     = resolveLocalPath(storagePath);

        if (!fs.existsSync(absPath)) {
            return res.status(404).json({ success: false, message: 'File not found on disk' });
        }

        const buffer = fs.readFileSync(absPath);
        res.setHeader('Content-Type', getMimeFromPath(storagePath));
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(storagePath)}"`);
        res.setHeader('Content-Length', buffer.length);
        res.end(buffer);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveLocalPath(storagePath) {
    let p = storagePath.startsWith('/') ? storagePath.slice(1) : storagePath;
    if (p.startsWith('uploads/')) p = p.slice('uploads/'.length);
    return path.join(LOCAL_ROOT, p);
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