// services/deviceService.js
const db = require('../config/db');

// ─── Utility: map raw errors to friendly messages ─────────────────────────────
function friendlyError(error, context = 'operation') {
    const msg = error.message || '';

    if (msg.includes('duplicate key')) {
        return 'A duplicate record was detected. Please check and try again.';
    }
    if (msg.includes('connect') || msg.includes('ECONNREFUSED')) {
        return 'We are having trouble reaching the server. Please try again shortly.';
    }
    if (msg.includes('not found') || msg.includes('does not exist')) {
        return msg;
    }
    if (msg.includes('violates foreign key')) {
        return 'This device cannot be deleted because it is referenced by other records.';
    }

    console.error(`❌ DeviceService error [${context}]:`, error);
    return `We could not complete this ${context}. Please try again.`;
}

class DeviceService {

    // ─── GET ALL DEVICES ─────────────────────────────────────────────────────
    async getAllDevices(filters = {}) {
        try {
            let query = `
                SELECT 
                    device_id, device_name, model, manufacturer,
                    plan_name, plan_details, monthly_cost,
                    contract_duration_months, status,
                    created_at, updated_at
                FROM device_catalog
                WHERE 1=1
            `;

            const params = [];
            let paramCount = 0;

            if (filters.status) {
                paramCount++;
                query += ` AND status = $${paramCount}`;
                params.push(filters.status);
            }

            if (filters.manufacturer) {
                paramCount++;
                query += ` AND manufacturer ILIKE $${paramCount}`;
                params.push(`%${filters.manufacturer}%`);
            }

            if (filters.min_price) {
                paramCount++;
                query += ` AND monthly_cost >= $${paramCount}`;
                params.push(parseFloat(filters.min_price));
            }

            if (filters.max_price) {
                paramCount++;
                query += ` AND monthly_cost <= $${paramCount}`;
                params.push(parseFloat(filters.max_price));
            }

            query += ` ORDER BY 
                CASE 
                    WHEN status = 'active' THEN 1
                    WHEN status = 'inactive' THEN 2
                    ELSE 3
                END, monthly_cost ASC
            `;

            if (filters.limit) {
                paramCount++;
                query += ` LIMIT $${paramCount}`;
                params.push(parseInt(filters.limit));
            }

            if (filters.offset) {
                paramCount++;
                query += ` OFFSET $${paramCount}`;
                params.push(parseInt(filters.offset));
            }

            const result = await db.query(query, params);

            // Get total count for pagination
            const countResult = await db.query('SELECT COUNT(*) FROM device_catalog');

            return {
                success: true,
                data: result.rows,
                pagination: {
                    total: parseInt(countResult.rows[0].count),
                    limit: filters.limit || null,
                    offset: filters.offset || 0
                }
            };
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching devices'));
        }
    }

    // ─── GET DEVICE BY ID ────────────────────────────────────────────────────
    async getDeviceById(deviceId) {
        try {
            const result = await db.query(
                `SELECT 
                    device_id, device_name, model, manufacturer,
                    plan_name, plan_details, monthly_cost,
                    contract_duration_months, status,
                    created_at, updated_at
                FROM device_catalog 
                WHERE device_id = $1`,
                [deviceId]
            );

            if (result.rows.length === 0) {
                throw new Error('Device not found.');
            }

            return result.rows[0];
        } catch (error) {
            if (error.message.includes('not found')) throw error;
            throw new Error(friendlyError(error, 'fetching device details'));
        }
    }

    // ─── GET DEVICES BY STATUS ───────────────────────────────────────────────
    async getDevicesByStatus(status) {
        try {
            const validStatuses = ['active', 'inactive', 'discontinued'];
            if (!validStatuses.includes(status)) {
                throw new Error('Invalid status. Status must be active, inactive, or discontinued.');
            }

            const result = await db.query(
                `SELECT 
                    device_id, device_name, model, manufacturer,
                    plan_name, plan_details, monthly_cost,
                    contract_duration_months, status,
                    created_at, updated_at
                FROM device_catalog 
                WHERE status = $1
                ORDER BY monthly_cost ASC`,
                [status]
            );

            return result.rows;
        } catch (error) {
            if (error.message.includes('Invalid status')) throw error;
            throw new Error(friendlyError(error, 'fetching devices by status'));
        }
    }

    // ─── SEARCH DEVICES ──────────────────────────────────────────────────────
    async searchDevices(searchTerm) {
        try {
            if (!searchTerm || searchTerm.trim() === '') {
                return this.getAllDevices();
            }

            const term = `%${searchTerm.toLowerCase()}%`;

            const result = await db.query(
                `SELECT 
                    device_id, device_name, model, manufacturer,
                    plan_name, plan_details, monthly_cost,
                    contract_duration_months, status,
                    created_at, updated_at
                FROM device_catalog 
                WHERE 
                    LOWER(device_name) LIKE $1 OR
                    LOWER(model) LIKE $1 OR
                    LOWER(manufacturer) LIKE $1 OR
                    LOWER(plan_name) LIKE $1 OR
                    LOWER(plan_details) LIKE $1
                ORDER BY 
                    CASE 
                        WHEN status = 'active' THEN 1
                        WHEN status = 'inactive' THEN 2
                        ELSE 3
                    END, monthly_cost ASC`,
                [term]
            );

            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'searching devices'));
        }
    }

    // ─── CREATE DEVICE ───────────────────────────────────────────────────────
    async createDevice(deviceData) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // Check for duplicate device (same model and manufacturer)
            const duplicateCheck = await client.query(
                `SELECT device_id FROM device_catalog 
                WHERE model = $1 AND manufacturer = $2`,
                [deviceData.model, deviceData.manufacturer]
            );

            if (duplicateCheck.rows.length > 0) {
                throw new Error('A device with this model and manufacturer already exists.');
            }

            // Validate required fields
            this.validateDeviceData(deviceData, 'create');

            const result = await client.query(
                `INSERT INTO device_catalog (
                    device_name, model, manufacturer, plan_name,
                    plan_details, monthly_cost, contract_duration_months,
                    status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING 
                    device_id, device_name, model, manufacturer,
                    plan_name, plan_details, monthly_cost,
                    contract_duration_months, status,
                    created_at, updated_at`,
                [
                    deviceData.device_name.trim(),
                    deviceData.model.trim(),
                    deviceData.manufacturer.trim(),
                    deviceData.plan_name.trim(),
                    deviceData.plan_details?.trim() || null,
                    parseFloat(deviceData.monthly_cost),
                    deviceData.contract_duration_months || null,
                    deviceData.status || 'Active'
                ]
            );

            await client.query('COMMIT');

            return {
                success: true,
                device: result.rows[0],
                message: 'Device created successfully.'
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error creating device:', error);
            return {
                success: false,
                message: error.message.includes('already exists') || error.message.includes('required')
                    ? error.message
                    : friendlyError(error, 'creating device')
            };
        } finally {
            client.release();
        }
    }

    // ─── UPDATE DEVICE ───────────────────────────────────────────────────────
    async updateDevice(deviceId, updateData) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // Check if device exists
            const existingDevice = await client.query(
                'SELECT * FROM device_catalog WHERE device_id = $1',
                [deviceId]
            );

            if (existingDevice.rows.length === 0) {
                throw new Error('Device not found.');
            }

            // Check for duplicate if model or manufacturer is being updated
            if (updateData.model || updateData.manufacturer) {
                const model = updateData.model || existingDevice.rows[0].model;
                const manufacturer = updateData.manufacturer || existingDevice.rows[0].manufacturer;

                const duplicateCheck = await client.query(
                    `SELECT device_id FROM device_catalog 
                    WHERE model = $1 AND manufacturer = $2 AND device_id != $3`,
                    [model, manufacturer, deviceId]
                );

                if (duplicateCheck.rows.length > 0) {
                    throw new Error('A device with this model and manufacturer already exists.');
                }
            }

            // Validate update data
            this.validateDeviceData(updateData, 'update');

            // Build dynamic update query
            const updates = [];
            const values = [];
            let paramCount = 1;

            const fields = ['device_name', 'model', 'manufacturer', 'plan_name',
                'plan_details', 'monthly_cost', 'contract_duration_months', 'status'];

            fields.forEach(field => {
                if (updateData[field] !== undefined) {
                    updates.push(`${field} = $${paramCount}`);

                    if (field === 'monthly_cost') {
                        values.push(parseFloat(updateData[field]));
                    } else if (field === 'contract_duration_months') {
                        values.push(updateData[field] || null);
                    } else {
                        values.push(typeof updateData[field] === 'string' ? updateData[field].trim() : updateData[field]);
                    }

                    paramCount++;
                }
            });

            updates.push(`updated_at = NOW()`);

            const query = `
                UPDATE device_catalog 
                SET ${updates.join(', ')}
                WHERE device_id = $${paramCount}
                RETURNING 
                    device_id, device_name, model, manufacturer,
                    plan_name, plan_details, monthly_cost,
                    contract_duration_months, status,
                    created_at, updated_at
            `;

            values.push(deviceId);

            const result = await client.query(query, values);

            await client.query('COMMIT');

            return {
                success: true,
                device: result.rows[0],
                message: 'Device updated successfully.'
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error updating device:', error);

            return {
                success: false,
                message: error.message.includes('not found') || error.message.includes('already exists') || error.message.includes('required')
                    ? error.message
                    : friendlyError(error, 'updating device')
            };
        } finally {
            client.release();
        }
    }

    // ─── DELETE DEVICE ───────────────────────────────────────────────────────
    async deleteDevice(deviceId) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // Check if device exists
            const checkResult = await client.query(
                'SELECT device_id FROM device_catalog WHERE device_id = $1',
                [deviceId]
            );

            if (checkResult.rows.length === 0) {
                throw new Error('Device not found.');
            }

            // Check if device is referenced in applications
            const applicationCheck = await client.query(
                'SELECT application_id FROM application WHERE device_id = $1 LIMIT 1',
                [deviceId]
            );

            if (applicationCheck.rows.length > 0) {
                // Instead of deleting, set status to 'discontinued'
                await client.query(
                    `UPDATE device_catalog 
                    SET status = 'discontinued', updated_at = NOW() 
                    WHERE device_id = $1`,
                    [deviceId]
                );

                await client.query('COMMIT');

                return {
                    success: true,
                    message: 'Device has been discontinued as it is referenced by applications.',
                    discontinued: true
                };
            }

            // Safe to delete
            await client.query(
                'DELETE FROM device_catalog WHERE device_id = $1',
                [deviceId]
            );

            await client.query('COMMIT');

            return {
                success: true,
                message: 'Device deleted successfully.',
                discontinued: false
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error deleting device:', error);
            return {
                success: false,
                message: error.message.includes('not found')
                    ? error.message
                    : friendlyError(error, 'deleting device')
            };
        } finally {
            client.release();
        }
    }

    // ─── GET DEVICE STATISTICS ───────────────────────────────────────────────
    async getDeviceStatistics(filters = {}) {
        try {
            // Main statistics
            const statsQuery = `
                SELECT 
                    COUNT(*) as total_devices,
                    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active_devices,
                    COALESCE(SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END), 0) as inactive_devices,
                    COALESCE(SUM(CASE WHEN status = 'discontinued' THEN 1 ELSE 0 END), 0) as discontinued_devices,
                    COALESCE(AVG(monthly_cost), 0) as average_monthly_cost,
                    COALESCE(MIN(monthly_cost), 0) as min_monthly_cost,
                    COALESCE(MAX(monthly_cost), 0) as max_monthly_cost,
                    COALESCE(AVG(contract_duration_months), 0) as average_contract_duration
                FROM device_catalog
            `;

            // Devices by manufacturer
            const manufacturerStats = await db.query(`
                SELECT 
                    manufacturer,
                    COUNT(*) as device_count,
                    COALESCE(AVG(monthly_cost), 0) as avg_cost,
                    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active_count
                FROM device_catalog
                GROUP BY manufacturer
                ORDER BY device_count DESC
            `);

            // Devices by price range
            const priceRangeStats = await db.query(`
                SELECT 
                    CASE 
                        WHEN monthly_cost < 20 THEN 'Under R20'
                        WHEN monthly_cost BETWEEN 20 AND 40 THEN 'R20 - R40'
                        WHEN monthly_cost BETWEEN 40 AND 60 THEN 'R40 - R60'
                        ELSE 'Above R60'
                    END as price_range,
                    COUNT(*) as device_count,
                    COALESCE(AVG(monthly_cost), 0) as avg_cost_in_range
                FROM device_catalog
                WHERE status = 'active'
                GROUP BY price_range
                ORDER BY MIN(monthly_cost)
            `);

            // Contract distribution
            const contractStats = await db.query(`
                SELECT 
                    COALESCE(contract_duration_months::text, 'No Contract') as contract_term,
                    COUNT(*) as device_count
                FROM device_catalog
                WHERE status = 'active'
                GROUP BY contract_duration_months
                ORDER BY 
                    CASE 
                        WHEN contract_duration_months IS NULL THEN 0
                        ELSE contract_duration_months
                    END
            `);

            const [mainStats] = await Promise.all([db.query(statsQuery)]);

            return {
                success: true,
                data: {
                    summary: mainStats.rows[0],
                    by_manufacturer: manufacturerStats.rows,
                    by_price_range: priceRangeStats.rows,
                    by_contract: contractStats.rows
                }
            };

        } catch (error) {
            throw new Error(friendlyError(error, 'fetching device statistics'));
        }
    }

    // ─── GET AVAILABLE DEVICES (for client applications) ─────────────────────
    async getAvailableDevices() {
        try {
            const result = await db.query(`
                SELECT 
                    device_id, device_name, model, manufacturer,
                    plan_name, plan_details, monthly_cost,
                    contract_duration_months
                FROM device_catalog
                WHERE status = 'active'
                ORDER BY monthly_cost ASC
            `);

            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching available devices'));
        }
    }

    // ─── BULK UPDATE DEVICE STATUS ───────────────────────────────────────────
    async bulkUpdateStatus(deviceIds, newStatus, reason = null) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            const validStatuses = ['active', 'inactive', 'discontinued'];
            if (!validStatuses.includes(newStatus)) {
                throw new Error('Invalid status provided.');
            }

            const result = await client.query(
                `UPDATE device_catalog 
                SET status = $1, updated_at = NOW()
                WHERE device_id = ANY($2::int[])
                RETURNING device_id, device_name, status`,
                [newStatus, deviceIds]
            );

            // Log the bulk update (you might want to create an audit log table)
            console.log(`Bulk status update: ${result.rowCount} devices updated to ${newStatus}`);

            await client.query('COMMIT');

            return {
                success: true,
                updated_count: result.rowCount,
                updated_devices: result.rows,
                message: `${result.rowCount} devices have been updated to ${newStatus}.`
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error in bulk status update:', error);
            return {
                success: false,
                message: error.message.includes('Invalid status')
                    ? error.message
                    : friendlyError(error, 'bulk updating device status')
            };
        } finally {
            client.release();
        }
    }

    // ─── VALIDATION HELPER ───────────────────────────────────────────────────
    validateDeviceData(data, operation = 'create') {
        const errors = [];

        if (operation === 'create') {
            if (!data.device_name?.trim()) {
                errors.push('Device name is required.');
            }
            if (!data.model?.trim()) {
                errors.push('Model is required.');
            }
            if (!data.manufacturer?.trim()) {
                errors.push('Manufacturer is required.');
            }
            if (!data.plan_name?.trim()) {
                errors.push('Plan name is required.');
            }
            if (data.monthly_cost === undefined || data.monthly_cost === null) {
                errors.push('Monthly cost is required.');
            }
        }

        // Common validations for both create and update
        if (data.monthly_cost !== undefined) {
            const cost = parseFloat(data.monthly_cost);
            if (isNaN(cost) || cost < 0) {
                errors.push('Monthly cost must be a positive number.');
            }
        }

        if (data.contract_duration_months !== undefined && data.contract_duration_months !== null) {
            const duration = parseInt(data.contract_duration_months);
            if (isNaN(duration) || duration < 0) {
                errors.push('Contract duration must be a positive number.');
            }
            if (![12, 24, 36].includes(duration) && duration > 0) {
                errors.push('Contract duration must be 12, 24, or 36 months.');
            }
        }

        if (data.status !== undefined) {
            const validStatuses = ['active', 'inactive', 'discontinued'];
            if (!validStatuses.includes(data.status)) {
                errors.push('Status must be active, inactive, or discontinued.');
            }
        }

        if (errors.length > 0) {
            throw new Error(errors.join(' '));
        }

        return true;
    }

    // ─── CHECK DEVICE AVAILABILITY ───────────────────────────────────────────
    async checkDeviceAvailability(deviceId) {
        try {
            const result = await db.query(
                `SELECT status, device_name FROM device_catalog WHERE device_id = $1`,
                [deviceId]
            );

            if (result.rows.length === 0) {
                return {
                    available: false,
                    reason: 'Device not found.',
                    device_name: null
                };
            }

            const device = result.rows[0];

            if (device.status !== 'active') {
                const statusMessages = {
                    inactive: 'This device is currently inactive.',
                    discontinued: 'This device has been discontinued.'
                };
                return {
                    available: false,
                    reason: statusMessages[device.status] || `Device is ${device.status}.`,
                    device_name: device.device_name
                };
            }

            return {
                available: true,
                device_name: device.device_name
            };

        } catch (error) {
            console.error('Error checking device availability:', error);
            throw new Error(friendlyError(error, 'checking device availability'));
        }
    }
}

module.exports = new DeviceService();