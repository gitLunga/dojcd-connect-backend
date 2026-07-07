const PDFDocument = require('pdfkit');

// ── Design constants ──────────────────────────────────────────────────────────
const NAVY   = '#003366';
const GOLD   = '#C8A84B';
const GRAY   = '#555555';
const LGRAY  = '#888888';
const BLACK  = '#1A1A1A';
const LINE   = '#CCCCCC';
const PAGE_W = 595.28;  // A4
const MARGIN = 50;
const BODY_W = PAGE_W - MARGIN * 2;

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeDoc() {
    return new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
}

function collectBuffer(doc) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });
}

function drawHeader(doc, refNumber) {
    // Top rule
    doc.rect(MARGIN, 45, BODY_W, 4).fill(NAVY);
    doc.rect(MARGIN, 49, BODY_W, 2).fill(GOLD);

    // Department name
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY)
       .text('DEPARTMENT OF JUSTICE AND CONSTITUTIONAL DEVELOPMENT', MARGIN, 62, { width: BODY_W });

    doc.font('Helvetica').fontSize(9).fillColor(LGRAY)
       .text('Republic of South Africa', MARGIN, 78, { width: BODY_W });

    // Reference + date flush right
    const dateStr = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' });
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
       .text(`Ref: ${refNumber}`, MARGIN, 62, { width: BODY_W, align: 'right' })
       .text(`Date: ${dateStr}`, MARGIN, 74, { width: BODY_W, align: 'right' });

    // Bottom rule
    doc.rect(MARGIN, 92, BODY_W, 1).fill(LINE);

    doc.y = 105;
}

function drawFooter(doc) {
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(pages.start + i);
        const y = doc.page.height - 42;
        doc.rect(MARGIN, y, BODY_W, 1).fill(LINE);
        doc.font('Helvetica').fontSize(7).fillColor(LGRAY)
           .text(
               'Department of Justice and Constitutional Development | Private Bag X81, Pretoria, 0001 | www.justice.gov.za',
               MARGIN, y + 5, { width: BODY_W, align: 'center' }
           )
           .text(`Page ${i + 1} of ${pages.count}`, MARGIN, y + 16, { width: BODY_W, align: 'center' });
    }
}

function sectionTitle(doc, title) {
    doc.moveDown(0.6);
    doc.rect(MARGIN, doc.y, BODY_W, 20).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF')
       .text(title.toUpperCase(), MARGIN + 8, doc.y - 14, { width: BODY_W - 16 });
    doc.fillColor(BLACK);
    doc.moveDown(0.4);
}

function kvRow(doc, label, value, yOverride) {
    const y = yOverride != null ? yOverride : doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY)
       .text(label, MARGIN, y, { width: 170, continued: false });
    doc.font('Helvetica').fontSize(9).fillColor(BLACK)
       .text(String(value ?? '—'), MARGIN + 175, y, { width: BODY_W - 175 });
    doc.moveDown(0.35);
}

function twoColKV(doc, left, right) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY)
       .text(left[0], MARGIN, y, { width: 80, continued: false });
    doc.font('Helvetica').fontSize(9).fillColor(BLACK)
       .text(String(left[1] ?? '—'), MARGIN + 82, y, { width: (BODY_W / 2) - 90 });

    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY)
       .text(right[0], MARGIN + (BODY_W / 2) + 10, y, { width: 80, continued: false });
    doc.font('Helvetica').fontSize(9).fillColor(BLACK)
       .text(String(right[1] ?? '—'), MARGIN + (BODY_W / 2) + 92, y, { width: (BODY_W / 2) - 100 });

    doc.moveDown(0.35);
}

function formatDate(val) {
    if (!val) return '—';
    return new Date(val).toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' });
}

function formatMoney(val) {
    if (val == null) return '—';
    return `R ${Number(val).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ALLOCATION LETTER
//    Issued when both approvals are done.
// ─────────────────────────────────────────────────────────────────────────────

async function generateAllocationLetter(data) {
    const { application, client, device, managerApproval, financeApproval } = data;

    const doc = makeDoc();
    const bufPromise = collectBuffer(doc);

    const refNo = `DOJCD/DEV/${application.application_id}/${new Date().getFullYear()}`;

    drawHeader(doc, refNo);

    // Document title
    doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY)
       .text('DEVICE ALLOCATION LETTER', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(LGRAY)
       .text('This letter confirms the official allocation of a departmental mobile device.', { align: 'center' });
    doc.moveDown(0.8);

    // Addressee block
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BLACK)
       .text(`${client.title || ''} ${client.first_name} ${client.last_name}`.trim());
    doc.font('Helvetica').fontSize(9)
       .text(client.email)
       .text(`PERSAL: ${client.persal_id || '—'}`)
       .text(`Department: ${client.department_id || '—'}`)
       .text(`Region: ${client.region || '—'}`);
    doc.moveDown(0.8);

    // Opening paragraph
    doc.font('Helvetica').fontSize(9).fillColor(BLACK)
       .text(
           `Dear ${client.title || ''} ${client.last_name},`,
           { paragraphGap: 4 }
       )
       .moveDown(0.3)
       .text(
           `We are pleased to inform you that your application (Ref: ${refNo}) for a departmental mobile device has been approved. ` +
           `The device detailed below has been allocated to you in accordance with the Department of Justice and Constitutional Development ` +
           `Mobile Device Policy. Please note the conditions and responsibilities associated with this allocation.`,
           { width: BODY_W, align: 'justify' }
       );

    sectionTitle(doc, 'Applicant Information');
    twoColKV(doc, ['Full Name:', `${client.first_name} ${client.last_name}`], ['User Type:', client.user_type]);
    twoColKV(doc, ['PERSAL ID:', client.persal_id], ['Region:', client.region]);
    twoColKV(doc, ['Department:', client.department_id], ['Email:', client.email]);
    twoColKV(doc, ['Phone:', client.phone_number], ['Application Date:', formatDate(application.submission_date)]);

    sectionTitle(doc, 'Allocated Device');
    twoColKV(doc, ['Device:', device.device_name], ['Model:', device.model]);
    twoColKV(doc, ['Manufacturer:', device.manufacturer], ['Plan:', device.plan_name]);
    twoColKV(doc, ['Monthly Cost:', formatMoney(device.monthly_cost)], ['Contract Duration:', `${device.contract_duration_months} months`]);

    if (device.plan_details) {
        kvRow(doc, 'Plan Details:', device.plan_details);
    }

    sectionTitle(doc, 'Approval Chain');
    twoColKV(doc,
        ['Stage 1 – Manager Review:', ''],
        ['Approved By:', managerApproval ? `${managerApproval.first_name} ${managerApproval.last_name}` : '—']
    );
    twoColKV(doc,
        ['Approval Date:', formatDate(managerApproval?.approval_date)],
        ['Role:', managerApproval?.user_role || '—']
    );
    if (managerApproval?.notes) kvRow(doc, 'Notes:', managerApproval.notes);

    doc.moveDown(0.3);
    twoColKV(doc,
        ['Stage 2 – Finance Review:', ''],
        ['Approved By:', financeApproval ? `${financeApproval.first_name} ${financeApproval.last_name}` : '—']
    );
    twoColKV(doc,
        ['Approval Date:', formatDate(financeApproval?.approval_date)],
        ['Role:', financeApproval?.user_role || '—']
    );
    if (financeApproval?.notes) kvRow(doc, 'Notes:', financeApproval.notes);

    sectionTitle(doc, 'Terms and Conditions');
    doc.font('Helvetica').fontSize(8.5).fillColor(BLACK);
    const terms = [
        '1. The allocated device remains the property of the Department of Justice and Constitutional Development.',
        '2. The device must be used exclusively for official departmental business.',
        '3. The recipient is responsible for the safekeeping and proper use of the device.',
        '4. Loss, theft, or damage must be reported immediately to the IT Help Desk.',
        '5. The device must be returned upon contract expiry, resignation, or dismissal.',
        '6. Unauthorised software installation or modification of the device is prohibited.',
        '7. The department reserves the right to monitor device usage in accordance with applicable legislation.',
    ];
    terms.forEach(t => { doc.text(t, { width: BODY_W }); doc.moveDown(0.2); });

    doc.moveDown(0.8);

    // Signature block
    doc.font('Helvetica').fontSize(9).fillColor(BLACK)
       .text('Yours faithfully,')
       .moveDown(2.5);
    doc.rect(MARGIN, doc.y, 180, 1).fill(BLACK);
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(9)
       .text('Authorised Signatory');
    doc.font('Helvetica').fontSize(8).fillColor(LGRAY)
       .text('Department of Justice and Constitutional Development');

    drawFooter(doc);
    doc.end();
    return bufPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CONTRACT SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

async function generateContractSummary(data) {
    const { contract, client, device, order } = data;

    const doc = makeDoc();
    const bufPromise = collectBuffer(doc);

    const refNo = `DOJCD/CON/${contract.contract_id}/${new Date().getFullYear()}`;
    drawHeader(doc, refNo);

    doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY)
       .text('CONTRACT SUMMARY', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(LGRAY)
       .text('Official summary of the departmental device contract.', { align: 'center' });
    doc.moveDown(0.8);

    sectionTitle(doc, 'Contract Details');
    twoColKV(doc, ['Contract ID:', contract.contract_id], ['Order ID:', order.order_id]);
    twoColKV(doc, ['Activation Date:', formatDate(contract.activation_date)], ['Contract End Date:', formatDate(client.contract_end_date)]);
    twoColKV(doc, ['MTN Contract Ref:', contract.mtn_contract_ref], ['Billing Plan Ref:', contract.billing_plan_ref]);
    twoColKV(doc, ['IMEI:', contract.imei], ['SIM Number:', contract.sim_number]);
    twoColKV(doc, ['Duration:', `${client.contract_duration_months} months`], ['Network Provider:', client.network_provider]);

    sectionTitle(doc, 'Device Information');
    twoColKV(doc, ['Device:', device.device_name], ['Model:', device.model]);
    twoColKV(doc, ['Manufacturer:', device.manufacturer], ['Plan:', device.plan_name]);
    twoColKV(doc, ['Monthly Cost:', formatMoney(device.monthly_cost)], ['Order Date:', formatDate(order.order_date)]);

    sectionTitle(doc, 'Account Holder');
    twoColKV(doc, ['Name:', `${client.first_name} ${client.last_name}`], ['User Type:', client.user_type]);
    twoColKV(doc, ['PERSAL ID:', client.persal_id], ['Department:', client.department_id]);
    twoColKV(doc, ['Region:', client.region], ['Email:', client.email]);

    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(8).fillColor(LGRAY)
       .text('This document is computer-generated and is valid without a physical signature.', { align: 'center' });

    drawFooter(doc);
    doc.end();
    return bufPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ORDER CONFIRMATION
// ─────────────────────────────────────────────────────────────────────────────

async function generateOrderConfirmation(data) {
    const { order, application, client, device, delivery } = data;

    const doc = makeDoc();
    const bufPromise = collectBuffer(doc);

    const refNo = `DOJCD/ORD/${order.order_id}/${new Date().getFullYear()}`;
    drawHeader(doc, refNo);

    doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY)
       .text('ORDER CONFIRMATION', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(LGRAY)
       .text('This document confirms the placement of a device order.', { align: 'center' });
    doc.moveDown(0.8);

    sectionTitle(doc, 'Order Details');
    twoColKV(doc, ['Order ID:', order.order_id], ['Application ID:', application.application_id]);
    twoColKV(doc, ['Order Date:', formatDate(order.order_date)], ['Order Status:', order.order_status]);

    sectionTitle(doc, 'Device Ordered');
    twoColKV(doc, ['Device:', device.device_name], ['Model:', device.model]);
    twoColKV(doc, ['Manufacturer:', device.manufacturer], ['Plan:', device.plan_name]);
    twoColKV(doc, ['Monthly Cost:', formatMoney(device.monthly_cost)], ['Contract Duration:', `${device.contract_duration_months} months`]);

    sectionTitle(doc, 'Recipient');
    twoColKV(doc, ['Name:', `${client.first_name} ${client.last_name}`], ['PERSAL ID:', client.persal_id]);
    twoColKV(doc, ['Department:', client.department_id], ['Region:', client.region]);
    twoColKV(doc, ['Email:', client.email], ['Phone:', client.phone_number]);

    if (delivery) {
        sectionTitle(doc, 'Delivery Information');
        twoColKV(doc, ['Courier:', delivery.courier_name], ['Tracking No:', delivery.tracking_number]);
        twoColKV(doc, ['Delivery Address:', delivery.delivery_address], ['Status:', delivery.delivery_status]);
        if (delivery.estimated_delivery_date) {
            kvRow(doc, 'Estimated Delivery:', formatDate(delivery.estimated_delivery_date));
        }
    }

    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(8).fillColor(LGRAY)
       .text('This document is computer-generated and is valid without a physical signature.', { align: 'center' });

    drawFooter(doc);
    doc.end();
    return bufPromise;
}

module.exports = { generateAllocationLetter, generateContractSummary, generateOrderConfirmation };
