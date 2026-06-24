/**
 * Test Google Drive integration.
 * Run: node scripts/test-drive.js
 *
 * Creates a small test file in the configured Drive folder,
 * verifies it exists, then deletes it.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

(async () => {
  console.log('=== Google Drive Integration Test ===\n');

  // 1. Load credentials
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFile) {
    console.error('FAIL: GOOGLE_SERVICE_ACCOUNT_KEY_FILE not set in .env');
    process.exit(1);
  }

  const resolvedPath = path.resolve(process.cwd(), keyFile);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`FAIL: Key file not found at ${resolvedPath}`);
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  console.log('Service Account:', creds.client_email);
  console.log('Project:', creds.project_id);
  console.log('Key File:', keyFile);

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    console.error('FAIL: GOOGLE_DRIVE_FOLDER_ID not set in .env');
    process.exit(1);
  }
  console.log('Target Folder:', folderId);
  console.log('');

  // 2. Authenticate
  console.log('[1/5] Authenticating...');
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  try {
    await auth.authorize();
    console.log('  OK: JWT token obtained\n');
  } catch (err) {
    console.error('  FAIL: Authentication failed');
    console.error('  Error:', err.message);
    console.error('\n  Possible causes:');
    console.error('  - Google Drive API not enabled for project:', creds.project_id);
    console.error('  - Service account key revoked or disabled');
    console.error('  - Private key corrupted');
    console.error('\n  Fix: Go to https://console.cloud.google.com/apis/library/drive.googleapis.com?project=' + creds.project_id);
    console.error('  and enable the Google Drive API.');
    process.exit(1);
  }

  const drive = google.drive({ version: 'v3', auth });

  // 2.5 Check if target folder is accessible
  console.log('[2/5] Checking target folder access...');
  try {
    const folderRes = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, mimeType, driveId',
      supportsAllDrives: true,
    });
    console.log('  OK: Folder accessible');
    console.log('  Name:', folderRes.data.name);
    if (folderRes.data.driveId) {
      console.log('  Shared Drive ID:', folderRes.data.driveId, '(supportsAllDrives is required!)');
    } else {
      console.log('  Type: My Drive / Regular shared folder');
    }
    console.log('');
  } catch (err) {
    console.error('  FAIL: Cannot access target folder');
    console.error('  Error:', err.message);
    console.error('\n  The folder', folderId, 'is not accessible by', creds.client_email);
    console.error('  Share the folder with the service account email (Content Manager or Editor role).');
    process.exit(1);
  }

  // 3. Test upload
  console.log('[3/5] Uploading test file...');
  let fileId;
  try {
    const res = await drive.files.create({
      requestBody: {
        name: `_TEST_${Date.now()}.txt`,
        mimeType: 'text/plain',
        parents: [folderId],
      },
      media: {
        mimeType: 'text/plain',
        body: 'Certified Australia v2 Drive test — ' + new Date().toISOString(),
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true,
    });
    fileId = res.data.id;
    console.log('  OK: File created');
    console.log('  ID:', fileId);
    console.log('  Link:', res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`);
    console.log('');
  } catch (err) {
    console.error('  FAIL: Upload failed');
    console.error('  Error:', err.message);
    if (err.code === 404) {
      console.error('\n  The target folder does not exist or is not shared with the service account.');
      console.error('  Share folder', folderId, 'with', creds.client_email);
    } else if (err.code === 403) {
      console.error('\n  Permission denied. The service account needs Content Manager or Editor role on the folder.');
      console.error('  Service account:', creds.client_email);
    }
    process.exit(1);
  }

  // 4. Verify file exists
  console.log('[4/5] Verifying file...');
  try {
    const check = await drive.files.get({
      fileId,
      fields: 'id, name',
      supportsAllDrives: true,
    });
    console.log('  OK: File verified:', check.data.name, '\n');
  } catch (err) {
    console.error('  FAIL: Could not verify file:', err.message);
    process.exit(1);
  }

  // 5. Cleanup
  console.log('[5/5] Cleaning up...');
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
    console.log('  OK: Test file deleted\n');
  } catch (err) {
    console.error('  WARN: Could not delete test file:', err.message);
  }

  console.log('=== ALL TESTS PASSED ===');
  console.log('Google Drive integration is working correctly.');
})();
