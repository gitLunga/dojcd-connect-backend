// Lets the real controllers/services/middleware load without a database or the native
// bcrypt build. Call these BEFORE requiring anything under src/.

const Module = require('node:module');
const path   = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');

function stubModule(relativeToSrc, exports) {
    const id = require.resolve(path.join(SRC, relativeToSrc));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

// Deterministic stand-in so tests can read back which password was hashed.
const fakeBcrypt = {
    hash:    async (password) => `hashed:${password}`,
    compare: async (password, hash) => hash === `hashed:${password}`,
};

function stubBcrypt() {
    const load = Module._load;
    Module._load = function (request, ...rest) {
        return request === 'bcrypt' ? fakeBcrypt : load.call(this, request, ...rest);
    };
}

// A pg-like pool that records every query. `respond(sql, params)` may return { rows }.
// Call reset(respond) between tests: the same object stays stubbed into src/config/db.js.
function fakeDb(initial = () => ({ rows: [] })) {
    let respond = initial;
    const log = [];
    const released = { count: 0 };
    const run = async (sql, params = []) => {
        log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return respond(sql, params) || { rows: [] };
    };
    return {
        log, released,
        reset(next = () => ({ rows: [] })) { respond = next; log.length = 0; released.count = 0; },
        query: run,
        connect: async () => ({ query: run, release: () => { released.count++; } }),
        end: async () => {},
    };
}

module.exports = { stubModule, stubBcrypt, fakeDb, SRC };
