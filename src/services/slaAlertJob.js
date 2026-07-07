const cron           = require('node-cron');
const { runSlaAlerts } = require('./slaAlertService');

// ── Schedule ──────────────────────────────────────────────────────────────────
// Runs at 07:00 and 13:00 every weekday (Mon–Fri).
// Covers: the morning before staff start work, and a midday check.
// Change the schedule string to adjust — uses standard cron syntax:
//   '0 7,13 * * 1-5'  →  at 07:00 and 13:00, Monday to Friday
//   '0 * * * *'       →  every hour (for testing)

const SCHEDULE = process.env.SLA_ALERT_SCHEDULE || '0 7,13 * * 1-5';

function startSlaAlertJob() {
    if (!cron.validate(SCHEDULE)) {
        console.error(`[SLA Job] Invalid cron schedule: "${SCHEDULE}" — job not started.`);
        return;
    }

    cron.schedule(SCHEDULE, async () => {
        await runSlaAlerts();
    }, {
        timezone: process.env.TZ || 'Africa/Johannesburg',
    });

    console.log(`[SLA Job] Scheduled — "${SCHEDULE}" (tz: ${process.env.TZ || 'Africa/Johannesburg'})`);
}

module.exports = { startSlaAlertJob };
