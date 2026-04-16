// test-download.js - WITH .env LOADING
require('dotenv').config();  // ← ADD THIS LINE AT TOP

const adminService = require('./adminService');

(async () => {
    try {
        console.log('\n🔧 Environment Check:');
        console.log(`   DB_HOST: ${process.env.DB_HOST}`);
        console.log(`   DB_USER: ${process.env.DB_USER}`);
        console.log(`   DB_PASSWORD: ${process.env.DB_PASSWORD ? '***' : 'MISSING'}`);
        console.log(`   DB_NAME: ${process.env.DB_NAME}`);
        console.log();
        
        // Test invoice download
        console.log('📥 Testing invoice download for user 9...');
        const result = await adminService.getClientInvoice(9);
        
        console.log('✅ Success!');
        console.log('  - Buffer size:', result.buffer.length, 'bytes');
        console.log('  - MIME type:', result.mimeType);
        console.log('  - File name:', result.fileName);
        
        // Test document download
        console.log('\n📥 Testing document download (document ID 22)...');
        const doc = await adminService.downloadUserDocument(22);
        
        console.log('✅ Success!');
        console.log('  - Buffer size:', doc.buffer.length, 'bytes');
        console.log('  - MIME type:', doc.mimeType);
        console.log('  - File name:', doc.fileName);
        
        console.log('\n✅ All tests passed!');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
