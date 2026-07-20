const nodemailer = require('nodemailer');

const FROM = process.env.EMAIL_FROM || 'DOJCD Connect <noreply@dojcd.gov.za>';
const DEV  = !process.env.EMAIL_HOST;

// Transporter is created lazily so a missing config does not crash the server.
let _transporter = null;

function getTransporter() {
    if (_transporter) return _transporter;
    if (DEV) return null;

    _transporter = nodemailer.createTransport({
        host:   process.env.EMAIL_HOST,
        port:   parseInt(process.env.EMAIL_PORT || '587'),
        secure: process.env.EMAIL_SECURE === 'true',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
    });

    return _transporter;
}

// Core send — resolves true on success, false on failure.
// Never throws — all email sends are non-fatal by design.
async function send(to, subject, html) {
    const transporter = getTransporter();

    if (!transporter) {
        console.log(`[EMAIL DEV] To: ${to} | Subject: ${subject}`);
        return true;
    }

    try {
        await transporter.sendMail({ from: FROM, to, subject, html });
        return true;
    } catch (err) {
        console.error(`[EMAIL] Failed to send "${subject}" to ${to}:`, err.message);
        return false;
    }
}

// For password reset we need delivery confirmation — throws on failure.
async function sendCritical(to, subject, html) {
    const transporter = getTransporter();

    if (!transporter) {
        console.log(`[EMAIL DEV CRITICAL] To: ${to} | Subject: ${subject}`);
        return;
    }

    await transporter.sendMail({ from: FROM, to, subject, html });
}

// ── Templates ─────────────────────────────────────────────────────────────────

function wrap(body) {
    return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:8px;">
      <div style="background:#1a237e;padding:16px;border-radius:6px 6px 0 0;margin-bottom:24px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">DOJCD Connect</h2>
      </div>
      ${body}
      <hr style="margin:24px 0;border:none;border-top:1px solid #e0e0e0;">
      <p style="font-size:12px;color:#888;">This is an automated message from the DOJCD Connect system. Do not reply to this email.</p>
    </div>`;
}

async function sendWelcomeClient(to, firstName) {
    return send(to, 'Welcome to DOJCD Connect', wrap(`
      <p>Dear ${firstName},</p>
      <p>Your registration with <strong>DOJCD Connect</strong> was successful. You can now log in and complete your profile to apply for a device.</p>
      <p>Next step: log in and complete your profile by uploading your ID, payslip, and proof of residence.</p>
      <p>If you did not create this account, please contact your department administrator immediately.</p>
    `));
}

async function sendProfileUnderReview(to, firstName) {
    return send(to, 'Your profile is under review', wrap(`
      <p>Dear ${firstName},</p>
      <p>Thank you for completing your profile. Your documents have been submitted and are now under review.</p>
      <p>You will be notified by email and in the portal once your account has been verified.</p>
    `));
}

async function sendApplicationSubmitted(to, firstName, deviceName, applicationId) {
    return send(to, `Application #${applicationId} received`, wrap(`
      <p>Dear ${firstName},</p>
      <p>Your application for the <strong>${deviceName}</strong> (Reference #${applicationId}) has been received and is awaiting manager review.</p>
      <p>You can track the progress of your application by logging into the portal.</p>
    `));
}

async function sendApplicationApprovedByManager(to, firstName, deviceName, applicationId) {
    return send(to, `Application #${applicationId} approved by manager`, wrap(`
      <p>Dear ${firstName},</p>
      <p>Great news! Your application for the <strong>${deviceName}</strong> (Ref #${applicationId}) has been approved by your manager and forwarded to Finance for budget approval.</p>
      <p>You will receive another notification once Finance completes their review.</p>
    `));
}

async function sendApplicationFullyApproved(to, firstName, deviceName, applicationId) {
    return send(to, `Application #${applicationId} fully approved`, wrap(`
      <p>Dear ${firstName},</p>
      <p>Congratulations! Your application for the <strong>${deviceName}</strong> (Ref #${applicationId}) has been fully approved.</p>
      <p>The administrator will now place the order with MTN and you will be notified when your device is on its way.</p>
    `));
}

async function sendApplicationRejected(to, firstName, deviceName, applicationId, reason) {
    return send(to, `Application #${applicationId} decision`, wrap(`
      <p>Dear ${firstName},</p>
      <p>We regret to inform you that your application for the <strong>${deviceName}</strong> (Ref #${applicationId}) was not approved.</p>
      <p><strong>Reason:</strong> ${reason}</p>
      <p>Please contact your manager or department administrator if you have any questions.</p>
    `));
}

async function sendOrderPlaced(to, firstName, deviceName, orderId) {
    return send(to, `Your device order has been placed`, wrap(`
      <p>Dear ${firstName},</p>
      <p>Your order for the <strong>${deviceName}</strong> has been placed with MTN (Order #${orderId}).</p>
      <p>You will receive a notification with tracking information once your device has been dispatched.</p>
    `));
}

async function sendOrderDispatched(to, firstName, deviceName, orderId, trackingNumber = null) {
    return send(to, `Your device has been dispatched`, wrap(`
      <p>Dear ${firstName},</p>
      <p>Your <strong>${deviceName}</strong> is on its way! (Order #${orderId})</p>
      ${trackingNumber ? `<p>Tracking number: <strong>${trackingNumber}</strong></p>` : ''}
      <p>You will receive another notification once your device has been delivered.</p>
    `));
}

async function sendOrderDelivered(to, firstName, deviceName, orderId) {
    return send(to, `Your device has been delivered`, wrap(`
      <p>Dear ${firstName},</p>
      <p>Your <strong>${deviceName}</strong> has been delivered and your contract is now active (Order #${orderId}).</p>
      <p>You can view your contract details by logging into the portal.</p>
    `));
}

async function sendOperationalUserWelcome(to, firstName, role, defaultPassword) {
    return send(to, 'Your DOJCD Connect staff account', wrap(`
      <p>Dear ${firstName},</p>
      <p>A staff account has been created for you on <strong>DOJCD Connect</strong>.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0;">
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;width:40%;">Email</td><td style="padding:8px;">${to}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;">Temporary password</td><td style="padding:8px;font-family:monospace;">${defaultPassword}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;">Role</td><td style="padding:8px;">${role}</td></tr>
      </table>
      <p style="color:#c62828;"><strong>You will be prompted to change your password on first login.</strong></p>
      <p>Do not share your credentials. If you did not expect this email, contact your administrator immediately.</p>
    `));
}

async function sendPasswordResetRequest(to, firstName, resetUrl, expiryMinutes = 60) {
    return sendCritical(to, 'Password reset request', wrap(`
      <p>Dear ${firstName},</p>
      <p>We received a request to reset your DOJCD Connect password. Click the button below to set a new password:</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${resetUrl}" style="background:#1a237e;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;">Reset my password</a>
      </div>
      <p style="font-size:13px;color:#555;">Or copy this link into your browser: <br>${resetUrl}</p>
      <p>This link expires in <strong>${expiryMinutes} minutes</strong>. If you did not request a password reset, you can safely ignore this email — your password has not been changed.</p>
    `));
}

async function sendPasswordChanged(to, firstName) {
    return send(to, 'Security alert — your password has been changed', wrap(`
      <p>Dear ${firstName},</p>
      <p>Your DOJCD Connect password was changed successfully.</p>
      <p>If you did not make this change, please contact your administrator immediately and reset your password.</p>
    `));
}

async function sendSlaApproachingAlert(to, firstName, { applicationId, applicantName, deviceName, stageName, daysElapsed, slaDays, daysLeft }) {
    return send(to, `SLA Warning — Application #${applicationId} approaching deadline`, wrap(`
      <p>Dear ${firstName},</p>
      <p>This is an automated SLA warning for the following application currently awaiting your action:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0;">
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;width:40%;">Application</td><td style="padding:8px;">#${applicationId} — ${applicantName}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;">Device</td><td style="padding:8px;">${deviceName}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;">Current Stage</td><td style="padding:8px;">${stageName}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;">Time Elapsed</td><td style="padding:8px;">${daysElapsed} of ${slaDays} days</td></tr>
        <tr><td style="padding:8px;background:#fff3cd;font-weight:bold;color:#856404;">Time Remaining</td><td style="padding:8px;background:#fff3cd;color:#856404;font-weight:bold;">${daysLeft} day(s) until SLA deadline</td></tr>
      </table>
      <p style="color:#856404;font-weight:bold;">⚠ Please action this application soon to avoid an SLA breach.</p>
      <p>Log into the DOJCD Connect portal to review and approve or reject this application.</p>
    `));
}

async function sendSlaBreachedAlert(to, firstName, { applicationId, applicantName, deviceName, stageName, daysElapsed, slaDays, daysOver }) {
    return send(to, `SLA Breach — Application #${applicationId} is overdue`, wrap(`
      <p>Dear ${firstName},</p>
      <p>The following application has <strong style="color:#c62828;">exceeded its SLA deadline</strong> and requires immediate attention:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0;">
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;width:40%;">Application</td><td style="padding:8px;">#${applicationId} — ${applicantName}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;">Device</td><td style="padding:8px;">${deviceName}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;">Current Stage</td><td style="padding:8px;">${stageName}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5;font-weight:bold;">SLA Limit</td><td style="padding:8px;">${slaDays} day(s)</td></tr>
        <tr><td style="padding:8px;background:#ffebee;font-weight:bold;color:#c62828;">Days Overdue</td><td style="padding:8px;background:#ffebee;color:#c62828;font-weight:bold;">${daysOver} day(s) past deadline (${daysElapsed} days total)</td></tr>
      </table>
      <p style="color:#c62828;font-weight:bold;">🚨 This application is overdue. Immediate action is required.</p>
      <p>Escalate this to your supervisor if you are unable to action it immediately. Log into the DOJCD Connect portal for details.</p>
    `));
}

module.exports = {
    send,
    sendWelcomeClient,
    sendSlaApproachingAlert,
    sendSlaBreachedAlert,
    sendProfileUnderReview,
    sendApplicationSubmitted,
    sendApplicationApprovedByManager,
    sendApplicationFullyApproved,
    sendApplicationRejected,
    sendOrderPlaced,
    sendOrderDispatched,
    sendOrderDelivered,
    sendOperationalUserWelcome,
    sendPasswordResetRequest,
    sendPasswordChanged,
};
