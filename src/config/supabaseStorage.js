// config/supabaseStorage.js
// ─────────────────────────────────────────────────────────────────────────────
// Single shared Supabase client used for Storage operations (file upload/URL).
// Database queries still go through the existing pg pool in config/db.js.
//
// Required environment variables (add to Render → Environment):
//   SUPABASE_URL      — e.g. https://xyzxyzxyz.supabase.co
//   SUPABASE_SERVICE_KEY — the "service_role" secret key (NOT the anon key)
//
// Bucket setup (do this once in Supabase dashboard):
//   Storage → New bucket → name: "dojcd-documents" → Public: OFF (private)
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET               = process.env.SUPABASE_BUCKET || 'dojcd-documents';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
});

/**
 * Upload a file buffer to Supabase Storage and return the storage path.
 *
 * @param {Buffer}  buffer    — file contents (from multer memoryStorage)
 * @param {string}  mimeType  — e.g. 'application/pdf'
 * @param {string}  folder    — e.g. 'invoices', 'documents'
 * @param {string}  prefix    — e.g. 'invoice', 'id', 'payslip', 'residence'
 * @param {number}  userId    — client_user_id, used in filename
 * @returns {Promise<string>} — the storage path stored in DB (e.g. 'invoices/invoice_3_1234.pdf')
 */
async function uploadFile(buffer, mimeType, folder, prefix, userId) {
    const ext = getExtFromMime(mimeType);
    const filename = `${prefix}_${userId}_${Date.now()}${ext}`;
    const storagePath = `${folder}/${filename}`;

    // ✅ Map the MIME type to what Supabase accepts
    const normalizedMimeType = normalizeMimeType(mimeType);

    console.log(`📤 Uploading: ${storagePath}`);
    console.log(`   Original MIME: ${mimeType}`);
    console.log(`   Normalized MIME: ${normalizedMimeType}`);

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buffer, {
            contentType: normalizedMimeType,  // ✅ Use normalized MIME
            upsert: false,
        });

    if (error) {
        console.error('❌ Supabase upload error:', error.message);
        throw new Error(`File upload failed: ${error.message}`);
    }

    console.log(`✅ Uploaded to Supabase: ${storagePath}`);
    return storagePath;
}


/**
 * Generate a short-lived signed URL for a private file.
 * Default expiry: 60 minutes (3600 seconds).
 *
 * @param {string} storagePath  — path stored in DB (e.g. 'invoices/invoice_3_1234.pdf')
 * @param {number} expiresIn    — seconds until URL expires (default 3600)
 * @returns {Promise<string>}   — signed URL
 */
async function getSignedUrl(storagePath, expiresIn = 3600) {
    const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, expiresIn);

    if (error || !data?.signedUrl) {
        throw new Error(`Could not generate signed URL: ${error?.message || 'unknown error'}`);
    }

    return data.signedUrl;
}

function normalizeMimeType(mimeType) {
    const mimeMap = {
        'application/pdf': 'application/pdf',
        'image/jpeg': 'image/jpeg',
        'image/jpg': 'image/jpeg',  // Convert jpg to jpeg
        'image/png': 'image/png',
        'image/gif': 'image/gif',
        'image/webp': 'image/webp',
        'application/msword': 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return mimeMap[mimeType] || 'application/octet-stream';
}

/**
 * Download a file from Supabase Storage and return its Buffer.
 * Used by the view/download endpoints to proxy the file through the API.
 *
 * @param {string} storagePath
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function downloadFile(storagePath) {
    const { data, error } = await supabase.storage
        .from(BUCKET)
        .download(storagePath);

    if (error || !data) {
        throw new Error(`File not found in storage: ${error?.message || storagePath}`);
    }

    // data is a Blob in Node — convert to Buffer
    const arrayBuffer = await data.arrayBuffer();
    const buffer      = Buffer.from(arrayBuffer);
    const contentType = data.type || getMimeFromPath(storagePath);

    return { buffer, contentType };
}

/**
 * Delete a file from storage (used if a transaction rolls back).
 */
async function deleteFile(storagePath) {
    const { error } = await supabase.storage
        .from(BUCKET)
        .remove([storagePath]);

    if (error) {
        console.warn(`⚠️ Could not delete ${storagePath} from storage:`, error.message);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getExtFromMime(mimeType) {
    const map = {
        'application/pdf':   '.pdf',
        'image/jpeg':        '.jpg',
        'image/jpg':         '.jpg',
        'image/png':         '.png',
        'image/gif':         '.gif',
        'image/webp':        '.webp',
        'application/msword':'.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    };
    return map[mimeType] || '.bin';
}

function getMimeFromPath(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
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

module.exports = { uploadFile, getSignedUrl, downloadFile, deleteFile, getMimeFromPath, BUCKET };