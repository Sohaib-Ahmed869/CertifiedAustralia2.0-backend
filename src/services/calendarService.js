const { google } = require('googleapis');
const CalendarConnection = require('../models/CalendarConnection');
const AppError = require('../utils/AppError');

// ---------------------------------------------------------------------------
// OAuth2 client setup
// ---------------------------------------------------------------------------

const getGoogleOAuth2Client = () => {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI ||
    `${process.env.APP_BASE_URL || 'http://localhost:5000'}/api/calendar/google/callback`;

  if (!clientId || !clientSecret) {
    throw new AppError('Google Calendar OAuth credentials not configured', 500);
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

// ---------------------------------------------------------------------------
// Google Calendar OAuth
// ---------------------------------------------------------------------------

const getGoogleAuthUrl = (userId) => {
  const oauth2Client = getGoogleOAuth2Client();

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: JSON.stringify({ userId }),
  });
};

const handleGoogleCallback = async (code, state) => {
  const { userId } = JSON.parse(state);
  const oauth2Client = getGoogleOAuth2Client();

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Get user email from Google
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();

  // Upsert connection
  const connection = await CalendarConnection.findOneAndUpdate(
    { userId, provider: 'google' },
    {
      status: 'connected',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || undefined,
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      accountEmail: userInfo.email,
      calendarId: 'primary',
      connectedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  return connection;
};

// ---------------------------------------------------------------------------
// Outlook Calendar OAuth
// ---------------------------------------------------------------------------

const getOutlookAuthUrl = (userId) => {
  const clientId = process.env.OUTLOOK_CALENDAR_CLIENT_ID;
  const redirectUri = process.env.OUTLOOK_CALENDAR_REDIRECT_URI ||
    `${process.env.APP_BASE_URL || 'http://localhost:5000'}/api/calendar/outlook/callback`;

  if (!clientId) {
    throw new AppError('Outlook Calendar OAuth credentials not configured', 500);
  }

  const scope = encodeURIComponent('Calendars.ReadWrite User.Read offline_access');
  const state = encodeURIComponent(JSON.stringify({ userId }));

  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    `client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scope}&state=${state}&response_mode=query`;
};

const handleOutlookCallback = async (code, state) => {
  const { userId } = JSON.parse(state);
  const clientId = process.env.OUTLOOK_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.OUTLOOK_CALENDAR_REDIRECT_URI ||
    `${process.env.APP_BASE_URL || 'http://localhost:5000'}/api/calendar/outlook/callback`;

  // Exchange code for tokens
  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenResponse.json();
  if (tokens.error) {
    throw new AppError(`Outlook auth error: ${tokens.error_description || tokens.error}`, 400);
  }

  // Get user email
  const profileResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileResponse.json();

  const connection = await CalendarConnection.findOneAndUpdate(
    { userId, provider: 'outlook' },
    {
      status: 'connected',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || undefined,
      tokenExpiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : undefined,
      accountEmail: profile.mail || profile.userPrincipalName,
      connectedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  return connection;
};

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

const disconnect = async (userId, provider) => {
  const connection = await CalendarConnection.findOneAndUpdate(
    { userId, provider },
    { status: 'disconnected', accessToken: null, refreshToken: null, tokenExpiresAt: null },
    { new: true }
  );
  if (!connection) throw new AppError('Calendar connection not found', 404);
  return connection;
};

// ---------------------------------------------------------------------------
// Get connection status
// ---------------------------------------------------------------------------

const getConnections = async (userId) => {
  const connections = await CalendarConnection.find({ userId }).lean();

  const result = {
    google: null,
    outlook: null,
  };

  for (const conn of connections) {
    result[conn.provider] = {
      status: conn.status,
      accountEmail: conn.accountEmail,
      connectedAt: conn.connectedAt,
      lastSyncAt: conn.lastSyncAt,
      syncFollowUps: conn.syncFollowUps,
      syncDeadlines: conn.syncDeadlines,
    };
  }

  return result;
};

// ---------------------------------------------------------------------------
// Update sync preferences
// ---------------------------------------------------------------------------

const updateSyncPreferences = async (userId, provider, preferences) => {
  const connection = await CalendarConnection.findOneAndUpdate(
    { userId, provider, status: 'connected' },
    { $set: preferences },
    { new: true }
  );
  if (!connection) throw new AppError('No active calendar connection found', 404);
  return connection;
};

// ---------------------------------------------------------------------------
// Sync follow-up call to calendar
// ---------------------------------------------------------------------------

const refreshGoogleToken = async (connection) => {
  const oauth2Client = getGoogleOAuth2Client();
  oauth2Client.setCredentials({
    access_token: connection.accessToken,
    refresh_token: connection.refreshToken,
  });

  const { credentials } = await oauth2Client.refreshAccessToken();
  connection.accessToken = credentials.access_token;
  connection.tokenExpiresAt = new Date(credentials.expiry_date);
  await CalendarConnection.updateOne(
    { _id: connection._id },
    { accessToken: credentials.access_token, tokenExpiresAt: connection.tokenExpiresAt }
  );

  return oauth2Client;
};

const syncFollowUpToGoogle = async (connection, eventData) => {
  let oauth2Client;

  // Check if token needs refresh
  if (connection.tokenExpiresAt && new Date(connection.tokenExpiresAt) < new Date()) {
    oauth2Client = await refreshGoogleToken(connection);
  } else {
    oauth2Client = getGoogleOAuth2Client();
    oauth2Client.setCredentials({
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken,
    });
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const event = {
    summary: eventData.title,
    description: eventData.description || '',
    start: {
      dateTime: new Date(eventData.scheduledFor).toISOString(),
      timeZone: 'Australia/Sydney',
    },
    end: {
      dateTime: new Date(new Date(eventData.scheduledFor).getTime() + 30 * 60000).toISOString(),
      timeZone: 'Australia/Sydney',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 15 },
        { method: 'popup', minutes: 5 },
      ],
    },
  };

  const result = await calendar.events.insert({
    calendarId: connection.calendarId || 'primary',
    resource: event,
  });

  // Update last sync timestamp
  await CalendarConnection.updateOne(
    { _id: connection._id },
    { lastSyncAt: new Date() }
  );

  return result.data;
};

const syncFollowUpToOutlook = async (connection, eventData) => {
  const event = {
    subject: eventData.title,
    body: {
      contentType: 'text',
      content: eventData.description || '',
    },
    start: {
      dateTime: new Date(eventData.scheduledFor).toISOString(),
      timeZone: 'AUS Eastern Standard Time',
    },
    end: {
      dateTime: new Date(new Date(eventData.scheduledFor).getTime() + 30 * 60000).toISOString(),
      timeZone: 'AUS Eastern Standard Time',
    },
    isReminderOn: true,
    reminderMinutesBeforeStart: 15,
  };

  const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new AppError(`Outlook calendar error: ${err.error?.message || 'Unknown error'}`, 400);
  }

  await CalendarConnection.updateOne(
    { _id: connection._id },
    { lastSyncAt: new Date() }
  );

  return response.json();
};

/**
 * Sync a follow-up call event to all connected calendars for a user.
 */
const syncFollowUp = async (userId, eventData) => {
  const connections = await CalendarConnection.find({
    userId,
    status: 'connected',
    syncFollowUps: true,
  });

  const results = [];

  for (const conn of connections) {
    try {
      if (conn.provider === 'google') {
        const event = await syncFollowUpToGoogle(conn, eventData);
        results.push({ provider: 'google', success: true, eventId: event.id });
      } else if (conn.provider === 'outlook') {
        const event = await syncFollowUpToOutlook(conn, eventData);
        results.push({ provider: 'outlook', success: true, eventId: event.id });
      }
    } catch (err) {
      console.error(`[Calendar] Sync to ${conn.provider} failed:`, err.message);
      results.push({ provider: conn.provider, success: false, error: err.message });

      // Mark as expired if auth error
      if (err.message?.includes('invalid_grant') || err.message?.includes('401')) {
        await CalendarConnection.updateOne(
          { _id: conn._id },
          { status: 'expired' }
        );
      }
    }
  }

  return results;
};

/**
 * Sync a deadline event to all connected calendars for a user.
 * Used for task due dates and application deadlines.
 */
const syncDeadline = async (userId, eventData) => {
  const connections = await CalendarConnection.find({
    userId,
    status: 'connected',
    syncDeadlines: true,
  });

  const results = [];

  for (const conn of connections) {
    try {
      // Deadlines are all-day events
      const allDayData = {
        ...eventData,
        scheduledFor: eventData.scheduledFor || eventData.dueDate,
      };

      if (conn.provider === 'google') {
        const event = await syncDeadlineToGoogle(conn, allDayData);
        results.push({ provider: 'google', success: true, eventId: event.id });
      } else if (conn.provider === 'outlook') {
        const event = await syncDeadlineToOutlook(conn, allDayData);
        results.push({ provider: 'outlook', success: true, eventId: event.id });
      }
    } catch (err) {
      console.error(`[Calendar] Deadline sync to ${conn.provider} failed:`, err.message);
      results.push({ provider: conn.provider, success: false, error: err.message });

      if (err.message?.includes('invalid_grant') || err.message?.includes('401')) {
        await CalendarConnection.updateOne({ _id: conn._id }, { status: 'expired' });
      }
    }
  }

  return results;
};

const syncDeadlineToGoogle = async (connection, eventData) => {
  let oauth2Client;
  if (connection.tokenExpiresAt && new Date(connection.tokenExpiresAt) < new Date()) {
    oauth2Client = await refreshGoogleToken(connection);
  } else {
    oauth2Client = getGoogleOAuth2Client();
    oauth2Client.setCredentials({
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken,
    });
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const dueDate = new Date(eventData.scheduledFor).toISOString().split('T')[0];

  const event = {
    summary: `📋 ${eventData.title}`,
    description: eventData.description || '',
    start: { date: dueDate },
    end: { date: dueDate },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 60 * 24 }], // 1 day before
    },
  };

  const result = await calendar.events.insert({
    calendarId: connection.calendarId || 'primary',
    resource: event,
  });

  await CalendarConnection.updateOne({ _id: connection._id }, { lastSyncAt: new Date() });
  return result.data;
};

const syncDeadlineToOutlook = async (connection, eventData) => {
  const dueDate = new Date(eventData.scheduledFor).toISOString().split('T')[0];

  const event = {
    subject: `📋 ${eventData.title}`,
    body: { contentType: 'text', content: eventData.description || '' },
    start: { dateTime: `${dueDate}T00:00:00`, timeZone: 'AUS Eastern Standard Time' },
    end: { dateTime: `${dueDate}T23:59:59`, timeZone: 'AUS Eastern Standard Time' },
    isAllDay: true,
    isReminderOn: true,
    reminderMinutesBeforeStart: 60 * 24,
  };

  const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Outlook calendar sync failed');
  }

  await CalendarConnection.updateOne({ _id: connection._id }, { lastSyncAt: new Date() });
  return response.json();
};

/**
 * Get calendar events for a date range — aggregates tasks, follow-ups, and deadlines.
 *
 * `dateFrom`/`dateTo` are AEST civil dates ("YYYY-MM-DD") — the calendar cells the
 * user is looking at — and are widened to the matching UTC instants so a 5pm Sydney
 * follow-up lands on the Sydney day it was booked for, not the UTC one.
 *
 * Scoping: Admin/CEO oversee the whole pipeline and see every event; other staff
 * (agents) see what is theirs — assigned to them, created by them, or logged by them.
 */
const getCalendarEvents = async (user, dateFrom, dateTo) => {
  const Task = require('../models/Task');
  const Application = require('../models/Application');
  const { aestDayStartUtc, aestDayEndUtc, aestDateKey, aestTimeLabel } = require('../utils/aestTime');

  const userId = user?._id || user;
  const seesAll = ['Admin', 'CEOReportingManager'].includes(user?.role);

  const from = aestDayStartUtc(dateFrom) || new Date(dateFrom);
  const to = aestDayEndUtc(dateTo) || new Date(dateTo);

  const events = [];

  // Tasks with due dates in range
  const taskScope = seesAll ? {} : { $or: [{ assignedTo: userId }, { createdBy: userId }] };
  const tasks = await Task.find({
    ...taskScope,
    dueDate: { $gte: from, $lte: to },
  })
    .populate('applicationId', 'applicationId studentId')
    .populate('assignedTo', 'firstName lastName')
    .lean();

  for (const t of tasks) {
    events.push({
      id: `task-${t._id}`,
      type: 'task',
      title: t.title,
      date: t.dueDate,
      status: t.status,
      priority: t.priority,
      applicationId: t.applicationId?.applicationId,
      assignedTo: t.assignedTo ? `${t.assignedTo.firstName} ${t.assignedTo.lastName}` : null,
      dateKey: aestDateKey(t.dueDate),
      time: aestTimeLabel(t.dueDate),
      link: t.applicationId?.studentId
        ? `/admin/students/${t.applicationId.studentId}`
        : '/admin/tasks',
      color: t.priority === 'high' ? '#ef4444' : t.priority === 'medium' ? '#f59e0b' : '#3b82f6',
    });
  }

  // Follow-up calls in range.
  // Match on `loggedBy` as well as `assignedAgentId` — the follow-up belongs to
  // whoever booked it, and plenty of applications have no agent assigned yet.
  const followUpScope = seesAll
    ? {}
    : { $or: [{ assignedAgentId: userId }, { 'followUpCalls.loggedBy': userId }] };
  const appsWithFollowUps = await Application.find({
    ...followUpScope,
    'followUpCalls.scheduledFor': { $gte: from, $lte: to },
  })
    .populate('studentId', 'firstName lastName')
    .select('applicationId studentId followUpCalls assignedAgentId')
    .lean();

  for (const app of appsWithFollowUps) {
    const studentName = app.studentId
      ? `${app.studentId.firstName} ${app.studentId.lastName}`
      : 'Unknown';
    for (const call of app.followUpCalls || []) {
      if (!call.scheduledFor) continue;
      const d = new Date(call.scheduledFor);
      if (d < from || d > to) continue;
      // A matched application can carry follow-ups logged by someone else — keep
      // only the ones this user should see.
      if (!seesAll
        && String(app.assignedAgentId || '') !== String(userId)
        && String(call.loggedBy || '') !== String(userId)) continue;
      events.push({
        id: `followup-${app._id}-${call._id}`,
        type: 'follow_up',
        title: `Follow-up: ${studentName}`,
        date: call.scheduledFor,
        dateKey: aestDateKey(call.scheduledFor),
        time: aestTimeLabel(call.scheduledFor),
        status: call.completedAt ? 'done' : 'pending',
        applicationId: app.applicationId,
        link: `/admin/students/${app.studentId?._id || app._id}`,
        color: '#8b5cf6',
        notes: call.outcome || call.notes || '',
      });
    }
  }

  // Application deadlines (RTO completion) in range
  const deadlineScope = seesAll
    ? {}
    : { $or: [{ assignedAgentId: userId }, { assignedRTOId: userId }] };
  const deadlineApps = await Application.find({
    ...deadlineScope,
    rtoCompletionDeadline: { $gte: from, $lte: to },
  })
    .populate('studentId', 'firstName lastName')
    .select('applicationId studentId rtoCompletionDeadline status')
    .lean();

  for (const app of deadlineApps) {
    const studentName = app.studentId
      ? `${app.studentId.firstName} ${app.studentId.lastName}`
      : 'Unknown';
    events.push({
      id: `deadline-${app._id}`,
      type: 'deadline',
      title: `21-Day Deadline: ${studentName}`,
      date: app.rtoCompletionDeadline,
      dateKey: aestDateKey(app.rtoCompletionDeadline),
      time: aestTimeLabel(app.rtoCompletionDeadline),
      status: app.status,
      applicationId: app.applicationId,
      link: `/admin/students/${app.studentId?._id || app._id}`,
      color: '#ef4444',
    });
  }

  return events.sort((a, b) => new Date(a.date) - new Date(b.date));
};

module.exports = {
  getGoogleAuthUrl,
  handleGoogleCallback,
  getOutlookAuthUrl,
  handleOutlookCallback,
  disconnect,
  getConnections,
  updateSyncPreferences,
  syncFollowUp,
  syncDeadline,
  getCalendarEvents,
};
