// test-download.js (run once, then delete)
const adminService = require('./services/adminService');

(async () => {
    try {
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
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
})();
