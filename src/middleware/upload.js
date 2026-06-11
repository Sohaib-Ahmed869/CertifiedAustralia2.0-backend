const multer = require('multer');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const tmpDir = os.tmpdir();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tmpDir),
  filename: (_req, file, cb) => {
    const unique = crypto.randomUUID();
    cb(null, `${unique}_${file.originalname}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const blocked = /\.(exe|dll|bat|cmd|sh|ps1)$/i;
  if (blocked.test(file.originalname)) {
    cb(new Error('File type not allowed'), false);
  } else {
    cb(null, true);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB hard cap
});

module.exports = upload;
