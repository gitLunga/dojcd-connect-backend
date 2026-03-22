// config/supabaseStorage.js
// Unified storage: LOCAL DISK in dev, SUPABASE in production
// Set STORAGE_MODE=local in .env.local  OR  STORAGE_MODE=supabase in Render env

const fs   = require('fs');
const path = require('path');

const STORAGE_MODE = process.env.STORAGE_MODE
    || (process.env.NODE_ENV === 'production' ? 'supabase' : 'local');

const IS_LOCAL  = STORAGE_MODE === 'local';
const LOCAL_ROOT = path.join(__dirname, '..', 'uploads');
const BUCKET    = process.env.SUPABASE_BUCKET || 'dojcd-documents';

let supabase = null;
function getSupabase() {
    if (supabase) return supabase;
    const { createClient } = require('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    supabase = createClient(url, key, { auth: { persistSession: false } });
    return supabase;
}

console.log(`📦 Storage mode: ${IS_LOCAL ? 'LOCAL DISK' : 'SUPABASE'}`);

// ── uploadFile ────────────────────────────────────────────────────────────────
async function uploadFile(buffer, mimeType, folder, prefix, userId) {
    const ext      = getExtFromMime(mimeType);
    const filename = `${prefix}_${userId}_${Date.now()}${ext}`;
    const relPath  = `${folder}/${filename}`;

    if (IS_LOCAL) {
        const dir = path.join(LOCAL_ROOT, folder);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, filename), buffer);
        console.log(`✅ Saved locally: uploads/${relPath}`);
        return relPath;
    }

    const { error } = await getSupabase().storage
        .from(BUCKET).upload(relPath, buffer, { contentType: mimeType, upsert: false });
    if (error) throw new Error(`File upload failed: ${error.message}`);
    console.log(`✅ Uploaded to Supabase: ${relPath}`);
    return relPath;
}

// ── downloadFile ──────────────────────────────────────────────────────────────
async function downloadFile(storagePath) {
    if (IS_LOCAL) {
        const absPath = resolveLocalPath(storagePath);
        if (!fs.existsSync(absPath)) throw new Error(`File not found on disk: ${absPath}`);
        return { buffer: fs.readFileSync(absPath), contentType: getMimeFromPath(storagePath) };
    }

    const { data, error } = await getSupabase().storage.from(BUCKET).download(storagePath);
    if (error || !data) throw new Error(`File not found in storage: ${error?.message || storagePath}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    return { buffer, contentType: data.type || getMimeFromPath(storagePath) };
}

// ── getSignedUrl ──────────────────────────────────────────────────────────────
// Local  → backend proxy URL served by localFileRouter
// Supabase → short-lived signed URL
async function getSignedUrl(storagePath, expiresIn = 300) {
    if (IS_LOCAL) {
        const encoded = encodeURIComponent(storagePath);
        return `http://localhost:${process.env.PORT || 5000}/api/files/${encoded}`;
    }
    const { data, error } = await getSupabase().storage
        .from(BUCKET).createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl)
        throw new Error(`Could not generate signed URL: ${error?.message || 'unknown error'}`);
    return data.signedUrl;
}

// ── deleteFile ────────────────────────────────────────────────────────────────
async function deleteFile(storagePath) {
    if (IS_LOCAL) {
        try { fs.unlinkSync(resolveLocalPath(storagePath)); } catch {}
        return;
    }
    const { error } = await getSupabase().storage.from(BUCKET).remove([storagePath]);
    if (error) console.warn(`⚠️ Could not delete ${storagePath}:`, error.message);
}

// ── localFileRouter ───────────────────────────────────────────────────────────
// Mount in app.js:  app.use('/api/admin', storage.localFileRouter);
const express = require('express');
const localFileRouter = express.Router();

localFileRouter.get('/:encodedPath', (req, res) => {
    try {
        const storagePath = decodeURIComponent(req.params.encodedPath);
        const absPath     = resolveLocalPath(storagePath);
        if (!fs.existsSync(absPath))
            return res.status(404).json({ success: false, message: 'File not found on disk' });

        const buffer = fs.readFileSync(absPath);
        res.setHeader('Content-Type', getMimeFromPath(storagePath));
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

module.exports = { uploadFile, downloadFile, getSignedUrl, deleteFile, getMimeFromPath, BUCKET, IS_LOCAL, localFileRouter };