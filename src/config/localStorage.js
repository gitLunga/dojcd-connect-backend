const fs        = require('fs');
const path      = require('path');
const signedUrl = require('./signedUrl');

// UPLOADS_DIR lets deployments keep user files outside the code directory.
const LOCAL_ROOT = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'));

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

// ── getSignedUrl ───────────────────────────────────────────────────────────────
// Returns a short-lived link that /api/files will accept (see ./signedUrl.js).
// Call this only AFTER the caller has been authorised to see the file.
async function getSignedUrl(storagePath) {
    const normalised  = normaliseStoragePath(storagePath);
    const { exp, sig } = signedUrl.sign(normalised);
    const encodedPath = normalised.split('/').map(encodeURIComponent).join('/');
    return `/api/files/${encodedPath}?exp=${exp}&sig=${sig}`;
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

// ── cleanTempFiles ────────────────────────────────────────────────────────────
// Deletes files in src/uploads/temp/ older than maxAgeHours (default 24 h).
// Safe to call at startup — silently skips if the folder does not exist.
function cleanTempFiles(maxAgeHours = 24) {
    const tempDir = path.join(LOCAL_ROOT, 'temp');
    if (!fs.existsSync(tempDir)) return;

    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    let removed = 0;

    for (const name of fs.readdirSync(tempDir)) {
        const filePath = path.join(tempDir, name);
        try {
            const stat = fs.statSync(filePath);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
                removed++;
            }
        } catch (_) {}
    }

    if (removed > 0) console.log(`🧹 Cleaned ${removed} stale file(s) from uploads/temp/`);
}

// ── localFileRouter ───────────────────────────────────────────────────────────
// GET /api/files/<path>?exp=<unix s>&sig=<hmac>
// Serves a stored file only for a valid, unexpired signed link (see getSignedUrl).
// Mounted without the JWT middleware on purpose: <img>/<iframe>/window.open cannot
// send an Authorization header, so authorisation happens when the link is issued.
const express = require('express');
const localFileRouter = express.Router();

const LINK_REJECTED = { success: false, message: 'This file link is invalid or has expired.' };

localFileRouter.get(/\/(.*)/, (req, res) => {
    // Express has already URL-decoded the captured path once; decoding again would
    // let a double-encoded "..%252F" slip past the checks below.
    const storagePath = normaliseStoragePath(req.params[0]);

    if (!storagePath || !signedUrl.verify(storagePath, req.query.exp, req.query.sig)) {
        return res.status(403).json(LINK_REJECTED);
    }

    let absPath;
    try {
        absPath = resolveLocalPath(storagePath);
    } catch (_) {
        return res.status(403).json(LINK_REJECTED);
    }

    const safeName = path.basename(absPath).replace(/[^\w.\-]/g, '_');

    // sendFile streams the file and handles Range/ETag/If-Modified-Since (PDF viewers rely on Range).
    res.sendFile(path.relative(LOCAL_ROOT, absPath), {
        root: LOCAL_ROOT,
        dotfiles: 'deny',
        cacheControl: false,
        headers: {
            'Content-Type':           getMimeFromPath(absPath),
            'Content-Disposition':    `inline; filename="${safeName}"`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control':          'private, no-store',
        },
    }, (err) => {
        if (!err || res.headersSent) return;
        if (err.status === 404 || err.code === 'ENOENT') {
            return res.status(404).json({ success: false, message: 'File not found.' });
        }
        console.error('❌ /api/files error:', err.message);
        res.status(err.status || 500).json({ success: false, message: 'Could not serve file.' });
    });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
// "/uploads/documents/a.pdf", "uploads/documents/a.pdf" and "documents/a.pdf" are the same file.
function normaliseStoragePath(storagePath) {
    if (!storagePath) return '';
    let p = storagePath.startsWith('/') ? storagePath.slice(1) : storagePath;
    if (p.startsWith('uploads/')) p = p.slice('uploads/'.length);
    return p;
}

function resolveLocalPath(storagePath) {
    if (!storagePath) throw new Error('Storage path is empty');

    const resolved = path.resolve(LOCAL_ROOT, normaliseStoragePath(storagePath));

    // Security: the result must stay inside LOCAL_ROOT. (A plain startsWith(LOCAL_ROOT)
    // check would also accept siblings such as ".../uploads-backup/...".)
    const rel = path.relative(LOCAL_ROOT, resolved);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        throw new Error('Path traversal attempt detected');
    }

    return resolved;
}

function getExtFromMime(mimeType) {
    const map = {
        'application/pdf': '.pdf',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    };
    return map[mimeType] || '.bin';
}

function getMimeFromPath(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    const map = {
        'pdf': 'application/pdf',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] || 'application/octet-stream';
}

module.exports = { uploadFile, downloadFile, getSignedUrl, deleteFile, cleanTempFiles, getMimeFromPath, localFileRouter };