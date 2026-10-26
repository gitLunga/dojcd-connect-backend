// Run with: npm test   (Node's built-in test runner — no extra dependencies)
//
// Exercises the real /api/files router from src/config/localStorage.js:
// links must be signed and unexpired, and nothing outside UPLOADS_DIR may ever be served.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const http   = require('node:http');

// Environment must be in place BEFORE the modules under test are loaded.
const root       = fs.mkdtempSync(path.join(os.tmpdir(), 'dojcd-files-'));
const uploadsDir = path.join(root, 'uploads');
process.env.UPLOADS_DIR = uploadsDir;
process.env.JWT_SECRET  = 'test-secret-only-for-unit-tests-0123456789';
delete process.env.FILE_URL_SECRET;

const express   = require('express');
const storage   = require('../src/config/localStorage');
const signedUrl = require('../src/config/signedUrl');

const PDF_BODY    = '%PDF-1.4 citizen id document';
const DOC_PATH    = 'documents/id_5_1700000000000.pdf';
const SECRET_BODY = 'DB_PASSWORD=do-not-leak-me';

let server, port;

// Sends the request-target exactly as given (fetch() would collapse "/../").
function rawGet(target, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: target, headers }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

before(async () => {
    fs.mkdirSync(path.join(uploadsDir, 'documents'), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, DOC_PATH), PDF_BODY);

    fs.writeFileSync(path.join(root, '.env'), SECRET_BODY);                  // outside uploads/
    fs.mkdirSync(path.join(root, 'uploads-backup'));                          // sibling that shares the prefix
    fs.writeFileSync(path.join(root, 'uploads-backup', 'leak.txt'), SECRET_BODY);

    const app = express();
    app.use('/api/files', storage.localFileRouter);                           // mounted exactly like app.js
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
});

after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('/api/files — access control', () => {
    it('rejects a request with no signature (the old anonymous access)', async () => {
        const res = await rawGet(`/api/files/${DOC_PATH}`);
        assert.equal(res.status, 403);
        assert.ok(!res.body.includes('%PDF'));
    });

    it('serves a file for a link issued by getSignedUrl()', async () => {
        const link = await storage.getSignedUrl(DOC_PATH);
        assert.match(link, /^\/api\/files\/documents\/id_5_1700000000000\.pdf\?exp=\d+&sig=[\w-]+$/);

        const res = await rawGet(link);
        assert.equal(res.status, 200);
        assert.equal(res.body, PDF_BODY);
        assert.equal(res.headers['content-type'], 'application/pdf');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['cache-control'], 'private, no-store');
        assert.match(res.headers['content-disposition'], /^inline; filename="id_5_1700000000000\.pdf"$/);
    });

    it('treats legacy "/uploads/..." paths and clean paths as the same file', async () => {
        const res = await rawGet(await storage.getSignedUrl(`/uploads/${DOC_PATH}`));
        assert.equal(res.status, 200);
        assert.equal(res.body, PDF_BODY);
    });

    it('supports Range requests (PDF viewers need them)', async () => {
        const res = await rawGet(await storage.getSignedUrl(DOC_PATH), { Range: 'bytes=0-3' });
        assert.equal(res.status, 206);
        assert.equal(res.body, '%PDF');
    });

    it('rejects an expired link', async () => {
        const hourAgo = Date.now() - 60 * 60 * 1000;
        const { exp, sig } = signedUrl.sign(DOC_PATH, hourAgo);
        const res = await rawGet(`/api/files/${DOC_PATH}?exp=${exp}&sig=${sig}`);
        assert.equal(res.status, 403);
    });

    it('rejects a valid signature replayed against a different file', async () => {
        fs.writeFileSync(path.join(uploadsDir, 'documents', 'payslip_9.pdf'), 'someone else\'s payslip');
        const { exp, sig } = signedUrl.sign(DOC_PATH);
        const res = await rawGet(`/api/files/documents/payslip_9.pdf?exp=${exp}&sig=${sig}`);
        assert.equal(res.status, 403);
        assert.ok(!res.body.includes('payslip'));
    });

    it('rejects a tampered signature or a bumped expiry', async () => {
        const { exp, sig } = signedUrl.sign(DOC_PATH);
        const badSig = await rawGet(`/api/files/${DOC_PATH}?exp=${exp}&sig=${sig.slice(0, -2)}AA`);
        const badExp = await rawGet(`/api/files/${DOC_PATH}?exp=${Number(exp) + 86400}&sig=${sig}`);
        assert.equal(badSig.status, 403);
        assert.equal(badExp.status, 403);
    });

    it('rejects repeated/array query params', async () => {
        const { exp, sig } = signedUrl.sign(DOC_PATH);
        const res = await rawGet(`/api/files/${DOC_PATH}?exp=${exp}&sig=${sig}&sig=${sig}`);
        assert.equal(res.status, 403);
    });

    it('returns 404 without leaking server paths for a signed link to a missing file', async () => {
        const res = await rawGet(await storage.getSignedUrl('documents/does-not-exist.pdf'));
        assert.equal(res.status, 404);
        assert.ok(!res.body.includes(root));
        assert.ok(!/resolved|requested/.test(res.body));
    });
});

describe('/api/files — path traversal', () => {
    const attempts = {
        'raw ../ segments':          '/api/files/../../.env',
        'encoded slash':             '/api/files/..%2F.env',
        'double-encoded slash':      '/api/files/..%252F.env',
        'sibling directory prefix':  '/api/files/..%2Fuploads-backup%2Fleak.txt',
    };

    for (const [name, target] of Object.entries(attempts)) {
        it(`never serves files outside uploads/ — ${name} (unsigned)`, async () => {
            const res = await rawGet(target);
            assert.equal(res.status, 403);
            assert.ok(!res.body.includes('do-not-leak-me'));
        });
    }

    it('still refuses traversal even if a link for it were somehow signed', async () => {
        for (const evil of ['../.env', '../uploads-backup/leak.txt']) {
            const { exp, sig } = signedUrl.sign(evil);
            const res = await rawGet(`/api/files/${encodeURIComponent(evil).replace(/%2F/g, '%2F')}?exp=${exp}&sig=${sig}`);
            assert.equal(res.status, 403, evil);
            assert.ok(!res.body.includes('do-not-leak-me'), evil);
        }
    });
});

describe('signedUrl', () => {
    it('verifies what it signs and nothing else', () => {
        const { exp, sig } = signedUrl.sign('a/b.pdf');
        assert.equal(signedUrl.verify('a/b.pdf', exp, sig), true);
        assert.equal(signedUrl.verify('a/c.pdf', exp, sig), false);
        assert.equal(signedUrl.verify('a/b.pdf', 'NaN', sig), false);
        assert.equal(signedUrl.verify('a/b.pdf', exp, undefined), false);
        assert.equal(signedUrl.verify('a/b.pdf', exp, ['x']), false);
    });

    it('a dedicated FILE_URL_SECRET takes precedence over JWT_SECRET', () => {
        const { exp, sig } = signedUrl.sign('a/b.pdf');
        process.env.FILE_URL_SECRET = 'a-different-secret';
        try {
            assert.equal(signedUrl.verify('a/b.pdf', exp, sig), false);
        } finally {
            delete process.env.FILE_URL_SECRET;
        }
    });

    it('honours FILE_URL_TTL_SECONDS', () => {
        process.env.FILE_URL_TTL_SECONDS = '30';
        try {
            const now = 1_700_000_000_000;
            assert.equal(signedUrl.sign('a.pdf', now).exp, 1_700_000_030);
        } finally {
            delete process.env.FILE_URL_TTL_SECONDS;
        }
    });
});
