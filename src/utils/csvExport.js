// Converts an array of objects to a CSV string.
// columns: [{ key: 'field_name', label: 'Column Header' }, ...]
function toCSV(rows, columns) {
    if (!rows || rows.length === 0) {
        return columns.map(c => c.label).join(',') + '\n';
    }

    const escape = (val) => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"`
            : str;
    };

    const header = columns.map(c => escape(c.label)).join(',');
    const body   = rows.map(row =>
        columns.map(c => escape(row[c.key])).join(',')
    ).join('\n');

    return `${header}\n${body}`;
}

// Sets response headers for a CSV file download.
function sendCSV(res, filename, csvString) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csvString); // BOM so Excel auto-detects UTF-8
}

module.exports = { toCSV, sendCSV };
