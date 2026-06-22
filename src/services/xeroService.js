/**
 * Xero Integration Service — Foundation
 *
 * This service provides the skeleton for Xero OAuth2 connection,
 * invoice sync, and payment reconciliation.
 *
 * Requires Xero developer app credentials:
 *   XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI
 *
 * Full implementation requires the 'xero-node' SDK.
 */

const Payment = require('../models/Payment');
const AppError = require('../utils/AppError');

// Connection state (in production, store in DB)
let xeroConnection = {
  connected: false,
  tenantId: null,
  accessToken: null,
  refreshToken: null,
  tokenExpiresAt: null,
  connectedAt: null,
};

/**
 * Get the current Xero connection status.
 */
const getConnectionStatus = () => ({
  connected: xeroConnection.connected,
  tenantId: xeroConnection.tenantId,
  connectedAt: xeroConnection.connectedAt,
  tokenExpired: xeroConnection.tokenExpiresAt
    ? new Date() > new Date(xeroConnection.tokenExpiresAt)
    : true,
});

/**
 * Generate the Xero OAuth2 authorization URL.
 */
const getAuthUrl = () => {
  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI || 'http://localhost:5000/api/xero/callback';

  if (!clientId) {
    throw new AppError('XERO_CLIENT_ID not configured', 500);
  }

  const scopes = [
    'openid', 'profile', 'email', 'offline_access',
    'accounting.transactions', 'accounting.contacts',
    'accounting.settings.read',
  ].join(' ');

  return `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}`;
};

/**
 * Handle OAuth2 callback — exchange code for tokens.
 * Stub: in production, use xero-node SDK to complete the exchange.
 */
const handleCallback = async (code) => {
  // TODO: Exchange authorization code for tokens using Xero API
  // const tokenResponse = await xeroClient.apiCallback(code);

  xeroConnection = {
    connected: true,
    tenantId: null, // Set from token response
    accessToken: null,
    refreshToken: null,
    tokenExpiresAt: null,
    connectedAt: new Date(),
  };

  return { message: 'Xero connected (stub)', connection: getConnectionStatus() };
};

/**
 * Disconnect from Xero.
 */
const disconnect = () => {
  xeroConnection = {
    connected: false,
    tenantId: null,
    accessToken: null,
    refreshToken: null,
    tokenExpiresAt: null,
    connectedAt: null,
  };
  return { message: 'Disconnected from Xero' };
};

/**
 * Sync a portal invoice to Xero.
 * Stub: creates the invoice structure but doesn't call Xero API.
 */
const syncInvoice = async (paymentId) => {
  const payment = await Payment.findById(paymentId)
    .populate('applicationId', 'applicationId')
    .populate('studentId', 'firstName lastName email');

  if (!payment) throw new AppError('Payment not found', 404);

  // Build Xero invoice payload
  const invoiceData = {
    type: 'ACCREC', // Accounts Receivable
    contact: {
      name: payment.studentId
        ? `${payment.studentId.firstName} ${payment.studentId.lastName}`
        : 'Unknown',
      emailAddress: payment.studentId?.email,
    },
    lineItems: [{
      description: `Payment for ${payment.applicationId?.applicationId || 'application'}`,
      quantity: 1,
      unitAmount: payment.amount,
      accountCode: '200', // Revenue account
      taxType: 'OUTPUT', // GST
    }],
    date: payment.createdAt?.toISOString().split('T')[0],
    dueDate: payment.createdAt?.toISOString().split('T')[0],
    reference: payment.applicationId?.applicationId || '',
    status: 'AUTHORISED',
    currencyCode: 'AUD',
  };

  // TODO: Call Xero API to create invoice
  // const result = await xeroClient.accountingApi.createInvoices(tenantId, { invoices: [invoiceData] });

  // Mark as synced
  payment.xeroSyncStatus = 'pending'; // Would be 'synced' after real API call
  payment.updatedAt = new Date();
  await payment.save();

  return { payment: payment._id, invoiceData, status: 'stub_pending' };
};

/**
 * Reconcile Xero payments against portal records.
 * Stub: scans portal payments with pending sync status.
 */
const reconcile = async () => {
  const pendingPayments = await Payment.find({ xeroSyncStatus: 'pending' })
    .select('_id amount type status xeroSyncStatus')
    .lean();

  return {
    pendingCount: pendingPayments.length,
    pendingTotal: pendingPayments.reduce((s, p) => s + (p.amount || 0), 0),
    message: 'Reconciliation check complete (stub)',
  };
};

module.exports = {
  getConnectionStatus,
  getAuthUrl,
  handleCallback,
  disconnect,
  syncInvoice,
  reconcile,
};
