// Catalogue categories end to end: the real Express app on a real PostgreSQL (local sign-in mode).
// Skipped unless TEST_PG_HOST is set (see test/helpers/testDb.js).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { useTestDatabase } = require('./helpers/testDb');
const testDb = useTestDatabase();
const { stubBcrypt } = require('./helpers/stubs');
stubBcrypt();

let server, base, pool, tokens, adminToken, managerToken, clientToken;

const call = async (method, urlPath, { body, token } = {}) => {
    const res = await fetch(`${base}${urlPath}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, json, text };
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const categoryId = async (name) => (await one(`SELECT category_id FROM device_category WHERE lower(name) = lower($1)`, [name])).category_id;

const laptop = (over = {}) => ({
    device_name: 'Dell Latitude 5440', model: '5440', manufacturer: 'Dell', plan_name: 'Business Laptop 24', monthly_cost: 650,
    contract_duration_months: 24, ...over,
});
const dataPackage = (over = {}) => ({ device_name: '20GB Data Bundle', plan_name: 'Monthly 20GB', monthly_cost: 199, contract_duration_months: 12, ...over });

describe('catalogue categories (real PostgreSQL)', { skip: testDb.skip }, () => {
    before(async () => {
        await testDb.create();
        Object.assign(process.env, { SLA_ALERT_SCHEDULE: 'off', UPLOADS_DIR: path.join(os.tmpdir(), `dojcd-uploads-cat-${process.pid}`) });
        delete process.env.AUTH_PROVIDER;

        const app = require('../src/app');
        pool = require('../src/config/db');
        tokens = require('../src/services/tokenService');
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;

        adminToken   = tokens.generateAccessToken(1, 'Operational', 'Admin', null, false, false);
        managerToken = tokens.generateAccessToken(2, 'Operational', 'Manager', null, false, false);
        clientToken  = tokens.generateAccessToken(3, 'Client');
    });

    after(async () => {
        if (!testDb.enabled) return;
        await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
        await testDb.drop(pool);
    });

    // Every test starts from the migration's own state: no items, the seeded categories exactly as shipped.
    beforeEach(async () => {
        await pool.query(`TRUNCATE device_catalog RESTART IDENTITY CASCADE`);
        await pool.query(`DELETE FROM device_category`);
        await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '010_catalogue_categories.sql'), 'utf8'));
        await pool.query(`TRUNCATE audit_log RESTART IDENTITY`);
    });

    describe('the migration', () => {
        it('seeds the categories, with services not needing hardware details', async () => {
            const rows = (await pool.query(`SELECT name, requires_hardware_details AS hw FROM device_category ORDER BY sort_order`)).rows;
            assert.deepEqual(rows.map((r) => r.name), ['Mobile Phones', 'Tablets', 'Laptops & Computers', 'Routers & MiFi', 'Data & Connectivity', 'Accessories', 'Other Services']);
            assert.deepEqual(rows.filter((r) => !r.hw).map((r) => r.name), ['Data & Connectivity', 'Other Services']);
        });

        it('a legacy insert with no category lands in Mobile Phones', async () => {
            await pool.query(`INSERT INTO device_catalog (device_name, model, manufacturer, plan_name, monthly_cost, contract_duration_months, status)
                              VALUES ('Old phone', 'X1', 'Nokia', 'Plan', 100, 24, 'active')`);
            const row = await one(`SELECT c.name FROM device_catalog d JOIN device_category c USING (category_id)`);
            assert.equal(row.name, 'Mobile Phones');
        });

        it('re-running it is safe, and backfills items that have no category', async () => {
            await pool.query(`ALTER TABLE device_catalog ALTER COLUMN category_id DROP NOT NULL`);
            await pool.query(`INSERT INTO device_catalog (category_id, device_name, model, manufacturer, plan_name, monthly_cost, contract_duration_months, status)
                              VALUES (NULL, 'Pre-migration phone', 'X2', 'Nokia', 'Plan', 100, 24, 'active')`);
            await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '010_catalogue_categories.sql'), 'utf8'));
            const row = await one(`SELECT c.name FROM device_catalog d JOIN device_category c USING (category_id)`);
            assert.equal(row.name, 'Mobile Phones');
            assert.equal((await one(`SELECT count(*)::int AS n FROM device_category`)).n, 7, 'no duplicate categories');
        });
    });

    describe('reading categories', () => {
        it('everyone signed in sees the active categories with item counts; nobody else', async () => {
            await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: await categoryId('Laptops & Computers') }) });
            await call('POST', '/api/devices', { token: adminToken, body: laptop({ model: '5450', category_id: await categoryId('Laptops & Computers'), status: 'inactive' }) });

            const res = await call('GET', '/api/device-categories', { token: clientToken });
            assert.equal(res.status, 200);
            const cats = res.json.data.categories;
            assert.equal(cats.length, 7);
            const laptops = cats.find((c) => c.name === 'Laptops & Computers');
            assert.deepEqual({ total: laptops.total_items, active: laptops.active_items }, { total: 2, active: 1 });

            assert.equal((await call('GET', '/api/device-categories')).status, 401);
        });

        it('only an Admin may list the switched-off ones', async () => {
            assert.equal((await call('GET', '/api/device-categories?include_inactive=true', { token: clientToken })).status, 403);
            assert.equal((await call('GET', '/api/device-categories?include_inactive=true', { token: managerToken })).status, 403);
            await pool.query(`UPDATE device_category SET is_active = false WHERE name = 'Accessories'`);
            assert.equal((await call('GET', '/api/device-categories', { token: clientToken })).json.data.categories.length, 6);
            assert.equal((await call('GET', '/api/device-categories?include_inactive=true', { token: adminToken })).json.data.categories.length, 7);
        });
    });

    describe('managing categories', () => {
        it('an Admin adds one, which goes to the end and is audited', async () => {
            const res = await call('POST', '/api/device-categories', { token: adminToken, body: { name: '  Printers   &  Scanners ', description: 'Office print gear', requires_hardware_details: true } });
            assert.equal(res.status, 201, res.text);
            const c = res.json.data.category;
            assert.equal(c.name, 'Printers & Scanners', 'whitespace tidied');
            assert.equal(c.sort_order, 80);
            assert.deepEqual((await pool.query(`SELECT action, actor_id FROM audit_log WHERE entity_type = 'device_category'`)).rows, [{ action: 'CATEGORY_CREATED', actor_id: 1 }]);
        });

        it('refuses duplicates in any letter case, empty names, and everyone but Admins', async () => {
            assert.equal((await call('POST', '/api/device-categories', { token: adminToken, body: { name: 'tablets' } })).status, 409);
            assert.equal((await call('POST', '/api/device-categories', { token: adminToken, body: { name: '   ' } })).status, 400);
            assert.equal((await call('POST', '/api/device-categories', { token: adminToken, body: { name: 'x'.repeat(101) } })).status, 400);
            for (const token of [managerToken, clientToken]) {
                assert.equal((await call('POST', '/api/device-categories', { token, body: { name: 'Drones' } })).status, 403);
                assert.equal((await call('PUT', '/api/device-categories/1', { token, body: { name: 'Hacked' } })).status, 403);
                assert.equal((await call('DELETE', '/api/device-categories/1', { token })).status, 403);
            }
        });

        it('renames, reorders and switches off; a rename cannot collide with another category', async () => {
            const id = await categoryId('Accessories');
            const renamed = await call('PUT', `/api/device-categories/${id}`, { token: adminToken, body: { name: 'Add-ons', sort_order: 5, description: 'Extras' } });
            assert.equal(renamed.status, 200, renamed.text);
            assert.deepEqual({ n: renamed.json.data.category.name, o: renamed.json.data.category.sort_order }, { n: 'Add-ons', o: 5 });

            assert.equal((await call('PUT', `/api/device-categories/${id}`, { token: adminToken, body: { name: 'TABLETS' } })).status, 409);
            assert.equal((await call('PUT', '/api/device-categories/99999', { token: adminToken, body: { name: 'Nope' } })).status, 404);

            const off = await call('PUT', `/api/device-categories/${id}`, { token: adminToken, body: { is_active: false } });
            assert.equal(off.json.data.category.is_active, false);
            const first = (await call('GET', '/api/device-categories', { token: adminToken })).json.data.categories[0];
            assert.equal(first.name, 'Mobile Phones', 'ordering follows sort_order');
        });

        it('deleting is only possible for an empty category', async () => {
            const tablets = await categoryId('Tablets');
            await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: tablets }) });
            const blocked = await call('DELETE', `/api/device-categories/${tablets}`, { token: adminToken });
            assert.equal(blocked.status, 409);
            assert.match(blocked.json.message, /still holds 1 item/);

            const empty = await call('DELETE', `/api/device-categories/${await categoryId('Accessories')}`, { token: adminToken });
            assert.equal(empty.status, 200, empty.text);
            assert.equal((await call('DELETE', '/api/device-categories/99999', { token: adminToken })).status, 404);
            assert.ok((await pool.query(`SELECT action FROM audit_log WHERE entity_type = 'device_category'`)).rows.some((r) => r.action === 'CATEGORY_DELETED'));
        });
    });

    describe('catalogue items', () => {
        it('a laptop and a data package sit in their own categories', async () => {
            const a = await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: await categoryId('Laptops & Computers') }) });
            assert.equal(a.status, 201, a.text);
            assert.equal(a.json.device.category_name, 'Laptops & Computers');
            assert.equal(a.json.device.status, 'active', 'status defaults to the lower-case value the database allows');

            const b = await call('POST', '/api/devices', { token: adminToken, body: dataPackage({ category_id: await categoryId('Data & Connectivity') }) });
            assert.equal(b.status, 201, b.text);
            assert.equal(b.json.device.model, null);
            assert.equal(b.json.device.manufacturer, null);
        });

        it('model and manufacturer are required for hardware categories only', async () => {
            const hardware = await call('POST', '/api/devices', { token: adminToken, body: dataPackage({ category_id: await categoryId('Laptops & Computers') }) });
            assert.equal(hardware.status, 400);
            assert.match(hardware.json.message, /Model is required for Laptops & Computers/);
            assert.match(hardware.json.message, /Manufacturer is required/);

            await call('PUT', `/api/device-categories/${await categoryId('Tablets')}`, { token: adminToken, body: { requires_hardware_details: false } });
            const relaxed = await call('POST', '/api/devices', { token: adminToken, body: dataPackage({ category_id: await categoryId('Tablets') }) });
            assert.equal(relaxed.status, 201, 'an Admin can decide a category needs no hardware details');
        });

        it('with no category it goes to Mobile Phones, as before this existed', async () => {
            const res = await call('POST', '/api/devices', { token: adminToken, body: { device_name: 'Galaxy A15', model: 'A155', manufacturer: 'Samsung', plan_name: 'Smart 5GB', monthly_cost: 299, contract_duration_months: 24 } });
            assert.equal(res.status, 201, res.text);
            assert.equal(res.json.device.category_name, 'Mobile Phones');
        });

        it('rejects an unknown or switched-off category', async () => {
            const unknown = await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: 99999 }) });
            assert.equal(unknown.status, 400);
            assert.match(unknown.json.message, /category/i);

            await pool.query(`UPDATE device_category SET is_active = false WHERE name = 'Tablets'`);
            const off = await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: await categoryId('Tablets') }) });
            assert.equal(off.status, 400);
            assert.match(off.json.message, /switched off/);
        });

        it('two items of the same model and manufacturer are still refused, but model-less ones never clash', async () => {
            const cat = await categoryId('Laptops & Computers');
            await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: cat }) });
            assert.equal((await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: cat, device_name: 'Again' }) })).status, 400);

            const data = await categoryId('Data & Connectivity');
            assert.equal((await call('POST', '/api/devices', { token: adminToken, body: dataPackage({ category_id: data }) })).status, 201);
            assert.equal((await call('POST', '/api/devices', { token: adminToken, body: dataPackage({ category_id: data, device_name: '50GB Bundle' }) })).status, 201);
        });

        it('lists can be filtered by category, and search matches the category name', async () => {
            await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: await categoryId('Laptops & Computers') }) });
            await call('POST', '/api/devices', { token: adminToken, body: dataPackage({ category_id: await categoryId('Data & Connectivity') }) });

            const filtered = await call('GET', `/api/devices?category_id=${await categoryId('Data & Connectivity')}`, { token: adminToken });
            assert.deepEqual(filtered.json.data.map((d) => d.device_name), ['20GB Data Bundle']);

            const search = await call('GET', '/api/devices/search?q=laptops', { token: adminToken });
            assert.deepEqual(search.json.data.map((d) => d.device_name), ['Dell Latitude 5440']);

            const all = await call('GET', '/api/devices', { token: adminToken });
            assert.ok(all.json.data.every((d) => d.category_name), 'every item carries its category');
        });

        it('an item can be moved to another category, but not into one that needs details it lacks', async () => {
            const made = await call('POST', '/api/devices', { token: adminToken, body: dataPackage({ category_id: await categoryId('Data & Connectivity') }) });
            const id = made.json.device.device_id;

            const refused = await call('PUT', `/api/devices/${id}`, { token: adminToken, body: { category_id: await categoryId('Laptops & Computers') } });
            assert.equal(refused.status, 400);
            assert.match(refused.json.message, /Model is required for Laptops & Computers/);

            const moved = await call('PUT', `/api/devices/${id}`, { token: adminToken, body: { category_id: await categoryId('Other Services') } });
            assert.equal(moved.status, 200, moved.text);
            assert.equal(moved.json.device.category_name, 'Other Services');

            const withDetails = await call('PUT', `/api/devices/${id}`, {
                token: adminToken, body: { category_id: await categoryId('Accessories'), model: 'C-1', manufacturer: 'Belkin' },
            });
            assert.equal(withDetails.status, 200, withDetails.text);
            assert.equal(withDetails.json.device.category_name, 'Accessories');
        });

        it('statistics break the catalogue down by category', async () => {
            await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: await categoryId('Laptops & Computers') }) });
            const res = await call('GET', '/api/devices/stats/summary', { token: adminToken });
            const laptops = res.json.data.by_category.find((c) => c.category_name === 'Laptops & Computers');
            assert.deepEqual({ t: laptops.total_items, a: laptops.active_items }, { t: 1, a: 1 });
            assert.equal(res.json.data.by_category.length, 7);
        });
    });

    describe('what clients see', () => {
        it('the catalogue carries categories, and switching a category off hides its items and stops applications', async () => {
            const lap = await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: await categoryId('Laptops & Computers') }) });
            await call('POST', '/api/devices', { token: adminToken, body: dataPackage({ category_id: await categoryId('Data & Connectivity') }) });

            const before = await call('GET', '/api/applications/devices', { token: clientToken });
            assert.equal(before.status, 200);
            assert.deepEqual(before.json.data.devices.map((d) => d.category_name).sort(), ['Data & Connectivity', 'Laptops & Computers']);

            await call('PUT', `/api/device-categories/${await categoryId('Laptops & Computers')}`, { token: adminToken, body: { is_active: false } });
            const after = await call('GET', '/api/applications/devices', { token: clientToken });
            assert.deepEqual(after.json.data.devices.map((d) => d.device_name), ['20GB Data Bundle']);

            const details = await call('GET', `/api/applications/devices/${lap.json.device.device_id}`, { token: clientToken });
            assert.equal(details.status, 404, 'its items can no longer be opened or applied for');
        });

        it('the inventory report lists each item with its category', async () => {
            await call('POST', '/api/devices', { token: adminToken, body: laptop({ category_id: await categoryId('Laptops & Computers') }) });
            const rows = await require('../src/services/reportService').fetchInventoryData();
            assert.equal(rows[0].category_name, 'Laptops & Computers');
        });
    });
});
