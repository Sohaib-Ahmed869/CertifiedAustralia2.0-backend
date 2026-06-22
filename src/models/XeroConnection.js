const mongoose = require('mongoose');

const xeroConnectionSchema = new mongoose.Schema({
  tenantId: String,
  tenantName: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiresAt: Date,
  idToken: String,
  scopes: [String],
  status: {
    type: String,
    enum: ['connected', 'disconnected', 'expired', 'error'],
    default: 'disconnected',
  },
  connectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  connectedAt: Date,
  lastSyncAt: Date,
  lastSyncStatus: {
    type: String,
    enum: ['success', 'failed', 'pending'],
  },
  lastSyncError: String,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('XeroConnection', xeroConnectionSchema);
