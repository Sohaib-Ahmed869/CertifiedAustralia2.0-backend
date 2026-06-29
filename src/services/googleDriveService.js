const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const AppError = require('../utils/AppError');

const driveScopes = ['https://www.googleapis.com/auth/drive'];

/* ── Singleton Drive client (reuse across requests like the old project) ── */
let _driveClient = null;

/* ── In-memory folder cache: applicationId → Drive folder ID ── */
const _folderCache = new Map();

const loadServiceAccountCredentials = () => {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const jsonCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (jsonCredentials) {
    return JSON.parse(jsonCredentials);
  }

  if (keyFile) {
    const resolvedPath = path.isAbsolute(keyFile)
      ? keyFile
      : path.resolve(process.cwd(), keyFile);

    if (!fs.existsSync(resolvedPath)) {
      throw new AppError(`Google service account key file not found: ${resolvedPath}`, 500);
    }

    return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  }

  throw new AppError('Google service account credentials are not configured', 500);
};

const createDriveClient = () => {
  if (_driveClient) return _driveClient;

  const credentials = loadServiceAccountCredentials();

  if (!credentials.client_email || !credentials.private_key) {
    throw new AppError('Google service account key file is missing client_email or private_key', 500);
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: driveScopes,
  });

  _driveClient = google.drive({ version: 'v3', auth });
  return _driveClient;
};

const resolveFolderId = () => {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new AppError('GOOGLE_DRIVE_FOLDER_ID is required', 500);
  }

  return folderId;
};

const resolveParentFolderId = () => process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || resolveFolderId();

/* ── Helper: build a view link (webViewLink may be null on Shared Drives) ── */
const buildViewLink = (fileId, webViewLink) =>
  webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

/* ── Helper: attempt to set "anyone with link can read" (silently skip on Shared Drives) ── */
const trySetPublicRead = async (drive, fileId) => {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
  } catch (_) {
    // Shared Drives manage access via membership — individual permission not required
  }
};

/* ═══════════════════════════════════════════════════════
   URL DETECTION HELPERS (matches old project driveSetup.js)
   ═══════════════════════════════════════════════════════ */

const isDriveUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  return url.includes('drive.google.com') || url.includes('docs.google.com/');
};

const extractDriveFileId = (url) => {
  if (!url) return null;
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  const shortMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (shortMatch) return shortMatch[1];
  return null;
};

/* ═══════════════════════════════════════════════════════
   GET OR CREATE PER-APPLICATION FOLDER (with cache, like old project)
   ═══════════════════════════════════════════════════════ */

const getOrCreateAppFolder = async (applicationId, folderName) => {
  if (_folderCache.has(applicationId)) {
    return _folderCache.get(applicationId);
  }

  const drive = createDriveClient();
  const rootFolderId = resolveFolderId();

  // Search for existing folder with this applicationId in name
  const searchRes = await drive.files.list({
    q: `'${rootFolderId}' in parents and name contains '${applicationId}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    spaces: 'drive',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (searchRes.data.files && searchRes.data.files.length > 0) {
    const folderId = searchRes.data.files[0].id;
    _folderCache.set(applicationId, folderId);
    return folderId;
  }

  // Create new folder
  const name = folderName || applicationId;
  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  await trySetPublicRead(drive, folder.data.id);

  const folderId = folder.data.id;
  _folderCache.set(applicationId, folderId);
  return folderId;
};

/* ═══════════════════════════════════════════════════════
   UPLOAD FROM DISK (primary method for document uploads)
   ═══════════════════════════════════════════════════════ */

const uploadFileFromDisk = async ({
  filePath,
  fileName,
  mimeType,
  folderId,
  description,
}) => {
  const drive = createDriveClient();

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId || resolveFolderId()],
      description,
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  await trySetPublicRead(drive, response.data.id);

  return {
    id: response.data.id,
    fileName: response.data.name,
    webViewLink: buildViewLink(response.data.id, response.data.webViewLink),
  };
};

/* ═══════════════════════════════════════════════════════
   UPLOAD FROM BUFFER (in-memory uploads)
   ═══════════════════════════════════════════════════════ */

const uploadFileBuffer = async ({
  buffer,
  fileName,
  mimeType,
  folderId,
  description,
}) => {
  const drive = createDriveClient();
  const { PassThrough } = require('stream');
  const bufferStream = new PassThrough();
  bufferStream.end(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId || resolveFolderId()],
      description,
    },
    media: {
      mimeType,
      body: bufferStream,
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  await trySetPublicRead(drive, response.data.id);

  return {
    id: response.data.id,
    fileName: response.data.name,
    webViewLink: buildViewLink(response.data.id, response.data.webViewLink),
    downloadLink: `https://drive.google.com/uc?export=download&id=${response.data.id}`,
  };
};

/* ═══════════════════════════════════════════════════════
   DELETE FILE
   ═══════════════════════════════════════════════════════ */

const deleteFile = async (fileId) => {
  const drive = createDriveClient();

  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (err) {
    // On Shared Drives with Content Manager role, permanent delete may fail.
    // Try trashing the file instead (Content Managers can trash).
    if (err.code === 403 || err.code === 404 || err.response?.status === 403) {
      try {
        await drive.files.update({
          fileId,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });
        return;
      } catch (_) {
        // If trash also fails, swallow 404 (already gone)
      }
    }
    // 404 means already deleted — treat as success
    if (err.code !== 404 && err.response?.status !== 404) throw err;
  }
};

/* ═══════════════════════════════════════════════════════
   CREATE APPLICATION FOLDER (legacy — prefer getOrCreateAppFolder)
   ═══════════════════════════════════════════════════════ */

const createApplicationFolder = async ({ applicationId, studentName, qualificationCode }) => {
  const parts = [applicationId];
  if (studentName) parts.push(studentName);
  if (qualificationCode) parts.push(qualificationCode);
  const folderName = parts.join(' - ');

  const folderId = await getOrCreateAppFolder(applicationId, folderName);

  return { id: folderId, webViewLink: `https://drive.google.com/drive/folders/${folderId}` };
};

/* ═══════════════════════════════════════════════════════
   CREATE SUBMISSION SUBFOLDER
   ═══════════════════════════════════════════════════════ */

const createSubmissionSubfolder = async ({ parentFolderId, name }) => {
  const drive = createDriveClient();

  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  return response.data;
};

/* ═══════════════════════════════════════════════════════
   SHARE WITH EMAIL
   ═══════════════════════════════════════════════════════ */

const shareWithEmail = async ({ fileId, email, role = 'reader' }) => {
  if (!email) return null;

  const drive = createDriveClient();

  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        type: 'user',
        role,
        emailAddress: email,
      },
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });
  } catch (_) {
    // May fail on Shared Drives — access is inherited from membership
  }

  return true;
};

/* ═══════════════════════════════════════════════════════
   STREAM DRIVE FILE TO EXPRESS RESPONSE (for proxy-file endpoint)
   ═══════════════════════════════════════════════════════ */

const streamDriveFileToResponse = async (fileId, res, inline = false) => {
  const drive = createDriveClient();

  // Fetch metadata for Content-Type and filename
  const metaRes = await drive.files.get({
    fileId,
    fields: 'name, mimeType, size',
    supportsAllDrives: true,
  });
  const { name: fileName, mimeType, size } = metaRes.data;

  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  const disposition = inline ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
  if (size) res.setHeader('Content-Length', size);

  // Stream the file body
  const fileRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );

  return new Promise((resolve, reject) => {
    fileRes.data
      .on('end', resolve)
      .on('error', reject)
      .pipe(res);
  });
};

/* ═══════════════════════════════════════════════════════
   DOWNLOAD FILE AS BUFFER
   ═══════════════════════════════════════════════════════ */

const downloadFileBuffer = async (fileId) => {
  const drive = createDriveClient();

  const metaRes = await drive.files.get({
    fileId,
    fields: 'name, mimeType',
    supportsAllDrives: true,
  });

  const fileRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );

  return {
    buffer: Buffer.from(fileRes.data),
    fileName: metaRes.data.name,
    mimeType: metaRes.data.mimeType || 'application/octet-stream',
  };
};

/* ═══════════════════════════════════════════════════════
   GET FILE METADATA
   ═══════════════════════════════════════════════════════ */

const getFileMetadata = async (fileId) => {
  const drive = createDriveClient();

  const response = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink, webContentLink',
    supportsAllDrives: true,
  });

  return response.data;
};

module.exports = {
  createDriveClient,
  resolveFolderId,
  uploadFileBuffer,
  uploadFileFromDisk,
  deleteFile,
  createApplicationFolder,
  createSubmissionSubfolder,
  shareWithEmail,
  getOrCreateAppFolder,
  streamDriveFileToResponse,
  downloadFileBuffer,
  getFileMetadata,
  isDriveUrl,
  extractDriveFileId,
};
