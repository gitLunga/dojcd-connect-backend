// Catalogue categories (Mobile Phones, Tablets, Laptops & Computers ...).
//
// A category groups catalogue items and decides whether they need hardware details (model and manufacturer).
// Admins manage them; clients only see active categories that have active items.

const db = require('../config/db');
const auditService = require('./auditService');

class CategoryError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'CategoryError';
        this.status = status;
    }
}

const COLUMNS = `category_id, name, description, requires_hardware_details, sort_order, is_active, created_at, updated_at`;

function cleanName(value) {
    const name = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new CategoryError('A category name is required.');
    if (name.length > 100) throw new CategoryError('A category name can be at most 100 characters.');
    return name;
}

function cleanSort(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) throw new CategoryError('The display order must be a whole number.');
    return n;
}

const duplicate = (err) => err.code === '23505' || /duplicate key/.test(err.message || '');

class CategoryService {

    // Categories with how many items each holds. Clients (includeInactive false) see only active ones.
    async list({ includeInactive = false } = {}) {
        const { rows } = await db.query(
            `SELECT c.category_id, c.name, c.description, c.requires_hardware_details, c.sort_order, c.is_active,
                    COUNT(d.device_id)::int                                      AS total_items,
                    COUNT(d.device_id) FILTER (WHERE d.status = 'active')::int   AS active_items
               FROM device_category c
               LEFT JOIN device_catalog d ON d.category_id = c.category_id
              WHERE ($1 OR c.is_active)
              GROUP BY c.category_id
              ORDER BY c.sort_order, lower(c.name)`,
            [includeInactive]
        );
        return rows;
    }

    async getById(categoryId) {
        const { rows } = await db.query(`SELECT ${COLUMNS} FROM device_category WHERE category_id = $1`, [categoryId]);
        if (rows.length === 0) throw new CategoryError('Category not found.', 404);
        return rows[0];
    }

    async create(data, actorId = null) {
        const name = cleanName(data.name);
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const last = await client.query(`SELECT COALESCE(MAX(sort_order), 0) AS max FROM device_category`);
            const { rows } = await client.query(
                `INSERT INTO device_category (name, description, requires_hardware_details, sort_order)
                 VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
                [
                    name,
                    data.description?.trim() || null,
                    data.requires_hardware_details === undefined ? true : data.requires_hardware_details === true || data.requires_hardware_details === 'true',
                    cleanSort(data.sort_order, last.rows[0].max + 10),
                ]
            );
            const category = rows[0];
            if (actorId) {
                await auditService.log(client, {
                    actorId, actorType: 'Operational', action: 'CATEGORY_CREATED',
                    entityType: 'device_category', entityId: category.category_id, newValue: { name: category.name },
                });
            }
            await client.query('COMMIT');
            return category;
        } catch (err) {
            await client.query('ROLLBACK');
            if (duplicate(err)) throw new CategoryError(`A category called "${name}" already exists.`, 409);
            throw err;
        } finally {
            client.release();
        }
    }

    async update(categoryId, data, actorId = null) {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const found = await client.query(`SELECT ${COLUMNS} FROM device_category WHERE category_id = $1 FOR UPDATE`, [categoryId]);
            if (found.rows.length === 0) throw new CategoryError('Category not found.', 404);
            const before = found.rows[0];

            const next = {
                name: data.name !== undefined ? cleanName(data.name) : before.name,
                description: data.description !== undefined ? (data.description?.trim() || null) : before.description,
                requires_hardware_details: data.requires_hardware_details !== undefined
                    ? data.requires_hardware_details === true || data.requires_hardware_details === 'true' : before.requires_hardware_details,
                sort_order: cleanSort(data.sort_order, before.sort_order),
                is_active: data.is_active !== undefined ? data.is_active === true || data.is_active === 'true' : before.is_active,
            };

            const { rows } = await client.query(
                `UPDATE device_category
                    SET name = $1, description = $2, requires_hardware_details = $3, sort_order = $4, is_active = $5, updated_at = NOW()
                  WHERE category_id = $6 RETURNING ${COLUMNS}`,
                [next.name, next.description, next.requires_hardware_details, next.sort_order, next.is_active, categoryId]
            );
            if (actorId) {
                await auditService.log(client, {
                    actorId, actorType: 'Operational', action: 'CATEGORY_UPDATED',
                    entityType: 'device_category', entityId: categoryId,
                    oldValue: { name: before.name, is_active: before.is_active, requires_hardware_details: before.requires_hardware_details },
                    newValue: { name: next.name, is_active: next.is_active, requires_hardware_details: next.requires_hardware_details },
                });
            }
            await client.query('COMMIT');
            return rows[0];
        } catch (err) {
            await client.query('ROLLBACK');
            if (duplicate(err)) throw new CategoryError('Another category already has that name.', 409);
            throw err;
        } finally {
            client.release();
        }
    }

    // A category that still holds items cannot be deleted: its items would have nowhere to go.
    // Switch it off instead (is_active = false) and it disappears for clients.
    async remove(categoryId, actorId = null) {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const found = await client.query(`SELECT name FROM device_category WHERE category_id = $1 FOR UPDATE`, [categoryId]);
            if (found.rows.length === 0) throw new CategoryError('Category not found.', 404);

            const items = await client.query(`SELECT COUNT(*)::int AS n FROM device_catalog WHERE category_id = $1`, [categoryId]);
            if (items.rows[0].n > 0) {
                throw new CategoryError(
                    `"${found.rows[0].name}" still holds ${items.rows[0].n} item(s). Move or remove them first, or switch the category off instead.`, 409);
            }

            await client.query(`DELETE FROM device_category WHERE category_id = $1`, [categoryId]);
            if (actorId) {
                await auditService.log(client, {
                    actorId, actorType: 'Operational', action: 'CATEGORY_DELETED',
                    entityType: 'device_category', entityId: categoryId, oldValue: { name: found.rows[0].name },
                });
            }
            await client.query('COMMIT');
            return { category_id: categoryId, name: found.rows[0].name };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // For the catalogue: the category an item belongs to (or the default when none is given) and whether it may be used.
    async resolveForItem(queryable, categoryId) {
        const { rows } = categoryId === undefined || categoryId === null || categoryId === ''
            ? await queryable.query(`SELECT ${COLUMNS} FROM device_category WHERE category_id = default_device_category_id()`)
            : await queryable.query(`SELECT ${COLUMNS} FROM device_category WHERE category_id = $1`, [parseInt(categoryId, 10) || 0]);
        if (rows.length === 0) throw new CategoryError('That category does not exist.');
        return rows[0];
    }
}

module.exports = new CategoryService();
module.exports.CategoryError = CategoryError;
