const express = require('express');
const { protect } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const calendarService = require('../services/calendarService');

const router = express.Router();

// ── OAuth callback routes (no auth middleware — called by OAuth redirect) ────

// GET /api/calendar/google/callback — Google OAuth2 callback
router.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send('Missing OAuth code or state');
    }

    await calendarService.handleGoogleCallback(code, state);

    // Redirect back to frontend calendar settings page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/admin/settings/calendar?connected=google`);
  })
);

// GET /api/calendar/outlook/callback — Outlook OAuth2 callback
router.get(
  '/outlook/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send('Missing OAuth code or state');
    }

    await calendarService.handleOutlookCallback(code, state);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/admin/settings/calendar?connected=outlook`);
  })
);

// ── Protected routes ────────────────────────────────────────────────────────

router.use(protect);

// GET /api/calendar/connections — get connection status for current user
router.get(
  '/connections',
  asyncHandler(async (req, res) => {
    const connections = await calendarService.getConnections(req.user._id);
    res.json(connections);
  })
);

// GET /api/calendar/google/auth-url — get Google OAuth URL
router.get(
  '/google/auth-url',
  asyncHandler(async (req, res) => {
    const url = calendarService.getGoogleAuthUrl(req.user._id.toString());
    res.json({ url });
  })
);

// GET /api/calendar/outlook/auth-url — get Outlook OAuth URL
router.get(
  '/outlook/auth-url',
  asyncHandler(async (req, res) => {
    const url = calendarService.getOutlookAuthUrl(req.user._id.toString());
    res.json({ url });
  })
);

// POST /api/calendar/:provider/disconnect — disconnect a calendar
router.post(
  '/:provider/disconnect',
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    if (!['google', 'outlook'].includes(provider)) {
      return res.status(400).json({ message: 'Invalid provider' });
    }
    const connection = await calendarService.disconnect(req.user._id, provider);
    res.json({ message: `${provider} calendar disconnected`, connection });
  })
);

// PATCH /api/calendar/:provider/preferences — update sync preferences
router.patch(
  '/:provider/preferences',
  asyncHandler(async (req, res) => {
    const { provider } = req.params;
    const { syncFollowUps, syncDeadlines } = req.body;
    const connection = await calendarService.updateSyncPreferences(
      req.user._id,
      provider,
      { syncFollowUps, syncDeadlines }
    );
    res.json({ item: connection });
  })
);

// POST /api/calendar/sync-followup — manually sync a follow-up to calendars
router.post(
  '/sync-followup',
  asyncHandler(async (req, res) => {
    const { title, description, scheduledFor } = req.body;
    if (!title || !scheduledFor) {
      return res.status(400).json({ message: 'title and scheduledFor are required' });
    }
    const results = await calendarService.syncFollowUp(req.user._id, {
      title,
      description,
      scheduledFor,
    });
    res.json({ results });
  })
);

// GET /api/calendar/events — aggregated calendar events for the current user
router.get(
  '/events',
  asyncHandler(async (req, res) => {
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ message: 'dateFrom and dateTo are required' });
    }
    const events = await calendarService.getCalendarEvents(req.user, dateFrom, dateTo);
    res.json({ events });
  })
);

module.exports = router;
