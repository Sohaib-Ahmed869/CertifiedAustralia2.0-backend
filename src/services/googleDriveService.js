const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const AppError = require('../utils/AppError');

const driveScopes = ['https://www.googleapis.com/auth/drive'];

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
  const credentials = loadServiceAccountCredentials();

  if (!credentials.client_email || !credentials.private_key) {
    throw new AppError('Google service account key file is missing client_email or private_key', 500);
  }

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    driveScopes,
  );

  return google.drive({ version: 'v3', auth });
};

const resolveFolderId = () => {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new AppError('GOOGLE_DRIVE_FOLDER_ID is required', 500);
  }

  return folderId;
};

const resolveParentFolderId = () => process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || resolveFolderId();

const uploadFileBuffer = async ({
  buffer,
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
      body: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    },
    fields: 'id, webViewLink, webContentLink',
  });

  return response.data;
};

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
    fields: 'id, webViewLink, webContentLink',
  });

  return response.data;
};

const deleteFile = async (fileId) => {
  const drive = createDriveClient();

  try {
    await drive.files.delete({ fileId });
  } catch (err) {
    if (err.code !== 404) throw err;
  }
};

const createApplicationFolder = async ({ applicationId, studentName }) => {
  const drive = createDriveClient();
  const parentFolderId = resolveParentFolderId();
  const folderName = `${applicationId}${studentName ? ` - ${studentName}` : ''}`;

  const response = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, webViewLink',
  });

  return response.data;
};

const shareWithEmail = async ({ fileId, email, role = 'reader' }) => {
  const drive = createDriveClient();

  if (!email) {
    return null;
  }

  await drive.permissions.create({
    fileId,
    requestBody: {
      type: 'user',
      role,
      emailAddress: email,
    },
    sendNotificationEmail: false,
  });

  return true;
};

module.exports = {
  createDriveClient,
  resolveFolderId,
  uploadFileBuffer,
  uploadFileFromDisk,
  deleteFile,
  createApplicationFolder,
  shareWithEmail,
};
