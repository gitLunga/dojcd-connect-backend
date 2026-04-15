#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const folders = [
    'uploads',
    'uploads/invoices',
    'uploads/documents'
];

folders.forEach(folder => {
    const fullPath = path.join(__dirname, '..', folder);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
        console.log(`✅ Created: ${fullPath}`);
    }
});

console.log('✅ All folders initialized!');