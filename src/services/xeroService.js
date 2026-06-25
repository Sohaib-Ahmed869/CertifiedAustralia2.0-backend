/**
 * Xero Integration Service
 *
 * Full OAuth2 integration with Xero for:
 *   - Invoice creation (ACCREC for student payments, ACCPAY for RTO payables)
 *   - Payment reconciliation
 *   - Token management with auto-refresh
 *
 * Required env vars: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI
 */

const XeroConnection = require('../models/XeroConnection');
const Payment = require('../models/Payment');
const Application = require('../models/Application');
const AppError = require('../utils/AppError');

// ---------------------------------------------------------------------------
// Xero API base URLs
// ---------------------------------------------------------------------------

const XERO_IDENTITY_URL = 'https://identity.xero.com';
const XERO_API_URL = 'https://api.xero.com/api.xro/2.0';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

// Payment types that generate ACCREC invoices (student pays CA)
const ACCREC_TYPES = ['upfront', 'plan', 'manualMarkPaid'];
// Payment types that generate ACCPAY bills (CA pays RTO)
const ACCPAY_TYPES = ['rtoPayable', 'rtoPayment'];
// Payment types that generate credit notes
const CREDIT_NOTE_TYPES = ['refund'];
// Payment types that are internal adjustments (no Xero sync)
const INTERNAL_TYPES = ['discount'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Get or create the singleton XeroConnection document.
 */
const getConnection = async () => {
  let conn = await XeroConnection.findOne();
  if (!conn) {
    conn = await XeroConnection.create({ status: 'disconnected' });
  }
  return conn;
};

/**
 * Build Basic auth header for token exchange.
 */
const basicAuthHeader = () => {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppError('XERO_CLIENT_ID and XERO_CLIENT_SECRET must be configured', 500);
  }
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
};

/**
 * Exchange or refresh tokens via Xero identity endpoint.
 */
const exchangeToken = async (grantType, codeOrToken) => {
  const body = new URLSearchParams({ grant_type: grantType });
  if (grantType === 'authorization_code') {
    body.append('code', codeOrToken);
    body.append('redirect_uri', process.env.XERO_REDIRECT_URI || 'http://localhost:5000/api/xero/callback');
  } else {
    body.append('refresh_token', codeOrToken);
  }

  const res = await fetch(`${XERO_IDENTITY_URL}/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new AppError(`Xero token exchange failed: ${errBody}`, 502);
  }

  return res.json();
};

/**
 * Ensure the access token is fresh. Auto-refreshes if expired.
 * Returns the current access token string.
 */
const ensureValidToken = async () => {
  const conn = await getConnection();
  if (conn.status === 'disconnected') {
    throw new AppError('Xero is not connected. Please connect first.', 400);
  }

  // Refresh if token expires within the next 60 seconds
  const bufferMs = 60 * 1000;
  if (!conn.tokenExpiresAt || new Date() >= new Date(conn.tokenExpiresAt.getTime() - bufferMs)) {
    if (!conn.refreshToken) {
      conn.status = 'expired';
      await conn.save();
      throw new AppError('Xero token expired and no refresh token available. Please reconnect.', 401);
    }
    try {
      const tokenData = await exchangeToken('refresh_token', conn.refreshToken);
      conn.accessToken = tokenData.access_token;
      conn.refreshToken = tokenData.refresh_token || conn.refreshToken;
      conn.tokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
      conn.status = 'connected';
      conn.updatedAt = new Date();
      await conn.save();
    } catch (err) {
      conn.status = 'expired';
      conn.lastSyncError = err.message;
      await conn.save();
      throw new AppError('Xero token refresh failed. Please reconnect.', 401);
    }
  }

  return conn;
};

/**
 * Make an authenticated request to the Xero API.
 */
const xeroRequest = async (method, path, body = null) => {
  const conn = await ensureValidToken();
  const headers = {
    Authorization: `Bearer ${conn.accessToken}`,
    'xero-tenant-id': conn.tenantId,
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const url = path.startsWith('http') ? path : `${XERO_API_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    // Update sync error on connection
    await XeroConnection.updateOne({}, {
      lastSyncError: `${method} ${path}: ${res.status} — ${errText.substring(0, 500)}`,
      updatedAt: new Date(),
    });
    throw new AppError(`Xero API error (${res.status}): ${errText.substring(0, 200)}`, 502);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
};

// ---------------------------------------------------------------------------
// Public API — Connection management
// ---------------------------------------------------------------------------

/**
 * Get the current Xero connection status.
 */
const getConnectionStatus = async () => {
  const conn = await getConnection();
  return {
    connected: conn.status === 'connected',
    status: conn.status,
    tenantId: conn.tenantId,
    tenantName: conn.tenantName,
    connectedAt: conn.connectedAt,
    connectedBy: conn.connectedBy,
    lastSyncAt: conn.lastSyncAt,
    lastSyncStatus: conn.lastSyncStatus,
    lastSyncError: conn.lastSyncError,
    tokenExpired: conn.status === 'expired' ||
      (conn.tokenExpiresAt && new Date() >= conn.tokenExpiresAt),
  };
};

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

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state: Date.now().toString(36),
  });

  return `${XERO_IDENTITY_URL}/connect/authorize?${params.toString()}`;
};

/**
 * Handle OAuth2 callback — exchange code for tokens and fetch tenant.
 */
const handleCallback = async (code, userId) => {
  const tokenData = await exchangeToken('authorization_code', code);

  const conn = await getConnection();
  conn.accessToken = tokenData.access_token;
  conn.refreshToken = tokenData.refresh_token;
  conn.idToken = tokenData.id_token || null;
  conn.tokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
  conn.scopes = tokenData.scope ? tokenData.scope.split(' ') : [];
  conn.status = 'connected';
  conn.connectedAt = new Date();
  conn.connectedBy = userId || null;
  conn.updatedAt = new Date();

  // Fetch the connected tenant (org)
  try {
    const tenantsRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json' },
    });
    if (tenantsRes.ok) {
      const tenants = await tenantsRes.json();
      if (tenants.length > 0) {
        conn.tenantId = tenants[0].tenantId;
        conn.tenantName = tenants[0].tenantName;
      }
    }
  } catch {
    // Non-fatal — tenant info is nice-to-have
  }

  await conn.save();
  return { message: 'Xero connected successfully', connection: await getConnectionStatus() };
};

/**
 * Disconnect from Xero — revoke tokens and reset connection.
 */
const disconnect = async () => {
  const conn = await getConnection();

  // Attempt to revoke the token with Xero
  if (conn.refreshToken) {
    try {
      await fetch(`${XERO_IDENTITY_URL}/connect/revocation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: basicAuthHeader(),
        },
        body: new URLSearchParams({ token: conn.refreshToken }).toString(),
      });
    } catch {
      // Best-effort revocation — continue even if it fails
    }
  }

  conn.accessToken = null;
  conn.refreshToken = null;
  conn.idToken = null;
  conn.tokenExpiresAt = null;
  conn.tenantId = null;
  conn.tenantName = null;
  conn.status = 'disconnected';
  conn.updatedAt = new Date();
  await conn.save();

  return { message: 'Disconnected from Xero' };
};

// ---------------------------------------------------------------------------
// Public API — Invoice sync
// ---------------------------------------------------------------------------

/**
 * Build a Xero contact object from student data.
 */
const buildContact = (student) => {
  const name = student
    ? `${student.firstName || ''} ${student.lastName || ''}`.trim()
    : 'Unknown Student';
  return {
    Name: name,
    EmailAddress: student?.email || undefined,
    FirstName: student?.firstName || undefined,
    LastName: student?.lastName || undefined,
  };
};

/**
 * Sync a single student payment as an ACCREC invoice to Xero.
 */
const syncInvoice = async (paymentId) => {
  const payment = await Payment.findById(paymentId)
    .populate('applicationId', 'applicationId qualificationName')
    .populate('studentId', 'firstName lastName email');

  if (!payment) throw new AppError('Payment not found', 404);

  // Skip types that don't sync to Xero
  if (INTERNAL_TYPES.includes(payment.type)) {
    return { skipped: true, reason: `Payment type '${payment.type}' does not sync to Xero` };
  }

  // Skip if already synced
  if (payment.xeroSyncStatus === 'synced' && payment.xeroInvoiceId) {
    return { skipped: true, reason: 'Already synced', xeroInvoiceId: payment.xeroInvoiceId };
  }

  const appId = payment.applicationId?.applicationId || 'N/A';
  const qualName = payment.applicationId?.qualificationName || 'RPL Application';

  // Determine invoice type
  let invoiceType, accountCode, description;
  if (ACCREC_TYPES.includes(payment.type)) {
    invoiceType = 'ACCREC';
    accountCode = '200'; // Sales / Revenue
    description = `${qualName} — ${payment.type === 'plan' ? 'Installment payment' : 'Payment'} for ${appId}`;
  } else if (ACCPAY_TYPES.includes(payment.type)) {
    invoiceType = 'ACCPAY';
    accountCode = '310'; // Cost of Sales / RTO Fees
    description = `RTO fee for ${appId} — ${qualName}`;
  } else if (CREDIT_NOTE_TYPES.includes(payment.type)) {
    // Handle refunds as credit notes
    return await syncCreditNote(payment, appId, qualName);
  } else {
    return { skipped: true, reason: `Unhandled payment type: ${payment.type}` };
  }

  const invoiceData = {
    Type: invoiceType,
    Contact: buildContact(payment.studentId),
    LineItems: [{
      Description: description,
      Quantity: 1,
      UnitAmount: payment.amount,
      AccountCode: accountCode,
      TaxType: invoiceType === 'ACCREC' ? 'OUTPUT' : 'INPUT',
    }],
    Date: formatXeroDate(payment.createdAt),
    DueDate: formatXeroDate(payment.createdAt),
    Reference: appId,
    Status: 'AUTHORISED',
    CurrencyCode: 'AUD',
    LineAmountTypes: 'Inclusive',
  };

  try {
    const result = await xeroRequest('PUT', '/Invoices', { Invoices: [invoiceData] });
    const xeroInvoice = result.Invoices?.[0];

    payment.xeroInvoiceId = xeroInvoice?.InvoiceID || null;
    payment.xeroSyncStatus = 'synced';
    payment.xeroSyncedAt = new Date();
    payment.updatedAt = new Date();
    await payment.save();

    return {
      paymentId: payment._id,
      xeroInvoiceId: xeroInvoice?.InvoiceID,
      invoiceNumber: xeroInvoice?.InvoiceNumber,
      status: 'synced',
    };
  } catch (err) {
    payment.xeroSyncStatus = 'failed';
    payment.updatedAt = new Date();
    await payment.save();
    throw err;
  }
};

/**
 * Sync a refund as a Xero credit note.
 */
const syncCreditNote = async (payment, appId, qualName) => {
  const creditNoteData = {
    Type: 'ACCRECCREDIT',
    Contact: buildContact(payment.studentId),
    LineItems: [{
      Description: `Refund for ${appId} — ${qualName}`,
      Quantity: 1,
      UnitAmount: payment.amount,
      AccountCode: '200',
      TaxType: 'OUTPUT',
    }],
    Date: formatXeroDate(payment.createdAt),
    Reference: `REFUND-${appId}`,
    Status: 'AUTHORISED',
    CurrencyCode: 'AUD',
    LineAmountTypes: 'Inclusive',
  };

  try {
    const result = await xeroRequest('PUT', '/CreditNotes', { CreditNotes: [creditNoteData] });
    const xeroCreditNote = result.CreditNotes?.[0];

    payment.xeroInvoiceId = xeroCreditNote?.CreditNoteID || null;
    payment.xeroSyncStatus = 'synced';
    payment.xeroSyncedAt = new Date();
    payment.updatedAt = new Date();
    await payment.save();

    return {
      paymentId: payment._id,
      xeroCreditNoteId: xeroCreditNote?.CreditNoteID,
      status: 'synced',
    };
  } catch (err) {
    payment.xeroSyncStatus = 'failed';
    payment.updatedAt = new Date();
    await payment.save();
    throw err;
  }
};

/**
 * Batch-sync all unsynced payments to Xero.
 * Returns a summary of synced / failed / skipped counts.
 */
const syncAll = async () => {
  // Only sync completed payments that haven't been synced
  const unsynced = await Payment.find({
    status: 'completed',
    xeroSyncStatus: { $in: [null, 'pending', 'failed'] },
    type: { $nin: INTERNAL_TYPES },
  }).select('_id').lean();

  const results = { synced: 0, failed: 0, skipped: 0, errors: [] };

  for (const p of unsynced) {
    try {
      const r = await syncInvoice(p._id);
      if (r.skipped) results.skipped++;
      else results.synced++;
    } catch (err) {
      results.failed++;
      results.errors.push({ paymentId: p._id, error: err.message });
    }
  }

  // Update connection sync tracking
  await XeroConnection.updateOne({}, {
    lastSyncAt: new Date(),
    lastSyncStatus: results.failed > 0 ? 'failed' : 'success',
    lastSyncError: results.failed > 0 ? `${results.failed} payment(s) failed to sync` : null,
    updatedAt: new Date(),
  });

  return results;
};

// ---------------------------------------------------------------------------
// Public API — Reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile portal payments against Xero invoices.
 * Fetches paid invoices from Xero and matches them to portal payments.
 */
const reconcile = async () => {
  const conn = await getConnection();
  if (conn.status !== 'connected') {
    throw new AppError('Xero is not connected', 400);
  }

  // Fetch all AUTHORISED invoices from Xero that have payments
  const result = await xeroRequest('GET',
    '/Invoices?where=Status%3D%22PAID%22&page=1&order=UpdatedDateUTC%20DESC'
  );

  const xeroInvoices = result.Invoices || [];
  const xeroInvoiceIds = xeroInvoices.map((i) => i.InvoiceID);

  // Find portal payments that are synced but may have been paid in Xero
  const portalPayments = await Payment.find({
    xeroSyncStatus: 'synced',
    xeroInvoiceId: { $in: xeroInvoiceIds },
    status: { $ne: 'completed' },
  });

  let reconciled = 0;
  for (const payment of portalPayments) {
    const xeroInv = xeroInvoices.find((i) => i.InvoiceID === payment.xeroInvoiceId);
    if (xeroInv && xeroInv.Status === 'PAID') {
      payment.status = 'completed';
      payment.updatedAt = new Date();
      await payment.save();
      reconciled++;
    }
  }

  // Also count unmatched items
  const pendingSync = await Payment.countDocuments({
    status: 'completed',
    xeroSyncStatus: { $in: [null, 'pending', 'failed'] },
    type: { $nin: INTERNAL_TYPES },
  });

  const syncedNotPaid = await Payment.countDocuments({
    xeroSyncStatus: 'synced',
    status: { $ne: 'completed' },
  });

  // Update connection
  await XeroConnection.updateOne({}, {
    lastSyncAt: new Date(),
    lastSyncStatus: 'success',
    lastSyncError: null,
    updatedAt: new Date(),
  });

  return {
    reconciled,
    pendingSync,
    syncedAwaitingPayment: syncedNotPaid,
    xeroInvoicesChecked: xeroInvoices.length,
    message: reconciled > 0
      ? `${reconciled} payment(s) reconciled from Xero`
      : 'All synced payments are up to date',
  };
};

/**
 * Get a reconciliation summary report (no Xero API call — portal-side only).
 */
const getReconciliationReport = async () => {
  const [synced, pending, failed, totalPayments] = await Promise.all([
    Payment.countDocuments({ xeroSyncStatus: 'synced' }),
    Payment.countDocuments({ xeroSyncStatus: { $in: [null, 'pending'] }, status: 'completed', type: { $nin: INTERNAL_TYPES } }),
    Payment.countDocuments({ xeroSyncStatus: 'failed' }),
    Payment.countDocuments({ status: 'completed' }),
  ]);

  const [syncedAmount, pendingAmount, failedAmount] = await Promise.all([
    Payment.aggregate([
      { $match: { xeroSyncStatus: 'synced' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      { $match: { xeroSyncStatus: { $in: [null, 'pending'] }, status: 'completed', type: { $nin: INTERNAL_TYPES } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      { $match: { xeroSyncStatus: 'failed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  return {
    synced: { count: synced, amount: syncedAmount[0]?.total || 0 },
    pending: { count: pending, amount: pendingAmount[0]?.total || 0 },
    failed: { count: failed, amount: failedAmount[0]?.total || 0 },
    totalCompletedPayments: totalPayments,
  };
};

// ---------------------------------------------------------------------------
// Public API — Sync history (last N sync operations)
// ---------------------------------------------------------------------------

/**
 * Get list of recently synced payments.
 */
const getSyncHistory = async (page = 1, limit = 20) => {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Payment.find({ xeroSyncStatus: { $ne: null } })
      .sort({ xeroSyncedAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('applicationId', 'applicationId qualificationName')
      .populate('studentId', 'firstName lastName')
      .select('amount type status xeroSyncStatus xeroInvoiceId xeroSyncedAt createdAt')
      .lean(),
    Payment.countDocuments({ xeroSyncStatus: { $ne: null } }),
  ]);

  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatXeroDate = (date) => {
  if (!date) return new Date().toISOString().split('T')[0];
  return new Date(date).toISOString().split('T')[0];
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getConnectionStatus,
  getAuthUrl,
  handleCallback,
  disconnect,
  syncInvoice,
  syncAll,
  reconcile,
  getReconciliationReport,
  getSyncHistory,
};
