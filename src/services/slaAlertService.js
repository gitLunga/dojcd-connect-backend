const db                  = require('../config/db');
const { buildSlaCte }     = require('./slaService');
const notificationService = require('./notificationService');
const emailService        = require('./emailService');

// ── Which roles are responsible per application stage ────────────────────────
const STAGE_ROLES = {
    Pending:         ['Manager', 'Admin'],
    Pending_Finance: ['Finance', 'Admin'],
    Approved:        ['Admin'],
};

// ── Deduplication: has an alert of this type already been sent today? ────────
// Uses the notification table itself — no extra migration needed.
// Title format: "SLA Warning — App #X" / "SLA Breach — App #X"
async function alreadySentToday(userId, titleExact) {
    const res = await db.query(
        `SELECT 1 FROM notification
         WHERE user_id   = $1
           AND user_type = 'Operational'
           AND title     = $2
           AND created_at > NOW() - INTERVAL '23 hours'
         LIMIT 1`,
        [userId, titleExact]
    );
    return res.rows.length > 0;
}

// ── Find operational users responsible for a given application stage ─────────
async function getResponsibleUsers(applicationStatus) {
    const roles = STAGE_ROLES[applicationStatus];
    if (!roles || roles.length === 0) return [];

    const placeholders = roles.map((_, i) => `$${i + 1}`).join(', ');
    const res = await db.query(
        `SELECT op_user_id, first_name, email
         FROM operational_user
         WHERE user_role IN (${placeholders})
           AND is_deleted = false`,
        roles
    );
    return res.rows;
}

// ── Main alert runner ─────────────────────────────────────────────────────────
async function runSlaAlerts() {
    console.log(`[SLA Alerts] Running at ${new Date().toISOString()}`);

    let approaching = 0, breached = 0, skipped = 0;

    try {
        // Fetch all approaching + breached applications with applicant/device info
        const cte = buildSlaCte();
        const res = await db.query(
            cte + `
            SELECT
                sc.application_id,
                sc.application_status,
                sc.stage_name,
                sc.sla_days,
                sc.days_in_stage,
                sc.sla_percent_used,
                sc.sla_status,
                cu.first_name  AS applicant_first,
                cu.last_name   AS applicant_last,
                d.device_name
            FROM sla_calc sc
            JOIN client_user    cu ON sc.client_user_id = cu.client_user_id
            JOIN device_catalog d  ON sc.device_id      = d.device_id
            WHERE sc.sla_status IN ('approaching', 'breached')
            ORDER BY sc.sla_percent_used DESC`
        );

        const applications = res.rows;
        console.log(`[SLA Alerts] Found ${applications.length} application(s) needing alerts.`);

        for (const app of applications) {
            const isBreached   = app.sla_status === 'breached';
            const daysElapsed  = parseFloat(app.days_in_stage).toFixed(1);
            const slaDays      = parseInt(app.sla_days);
            const daysOver     = Math.max(0, parseFloat(app.days_in_stage) - slaDays).toFixed(1);
            const daysLeft     = Math.max(0, slaDays - parseFloat(app.days_in_stage)).toFixed(1);
            const applicantName = `${app.applicant_first} ${app.applicant_last}`;

            // Title used both for the system notification and deduplication key
            const title = isBreached
                ? `SLA Breach — App #${app.application_id}`
                : `SLA Warning — App #${app.application_id}`;

            const message = isBreached
                ? `${applicantName}'s application for ${app.device_name} has been in ${app.stage_name} for ${daysElapsed} days — ${daysOver} day(s) past the ${slaDays}-day deadline. Immediate action required.`
                : `${applicantName}'s application for ${app.device_name} has been in ${app.stage_name} for ${daysElapsed} days — ${daysLeft} day(s) remain before the ${slaDays}-day SLA is breached.`;

            const users = await getResponsibleUsers(app.application_status);

            for (const user of users) {
                // Skip if already notified today for this exact alert
                const alreadySent = await alreadySentToday(user.op_user_id, title);
                if (alreadySent) {
                    skipped++;
                    continue;
                }

                // System notification (in-app bell)
                await notificationService.createNotification(
                    user.op_user_id,
                    'Operational',
                    title,
                    message
                );

                // Email — fire and forget, non-fatal
                if (isBreached) {
                    emailService.sendSlaBreachedAlert(user.email, user.first_name, {
                        applicationId: app.application_id,
                        applicantName,
                        deviceName:    app.device_name,
                        stageName:     app.stage_name,
                        daysElapsed,
                        slaDays,
                        daysOver,
                    }).catch(() => {});
                    breached++;
                } else {
                    emailService.sendSlaApproachingAlert(user.email, user.first_name, {
                        applicationId: app.application_id,
                        applicantName,
                        deviceName:    app.device_name,
                        stageName:     app.stage_name,
                        daysElapsed,
                        slaDays,
                        daysLeft,
                    }).catch(() => {});
                    approaching++;
                }
            }
        }

        console.log(`[SLA Alerts] Done — ${approaching} approaching, ${breached} breach alert(s) sent, ${skipped} skipped (already sent today).`);
        return { approaching, breached, skipped, total: applications.length };

    } catch (err) {
        console.error('[SLA Alerts] Error running SLA alerts:', err.message);
        return { error: err.message };
    }
}

module.exports = { runSlaAlerts };
