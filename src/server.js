const path = require('path');
const http = require('http');
const dotenv = require('dotenv');

// NOTE: dotenv DEFERS to any variable already present in process.env, so a
// process manager holding a stale environment (pm2 snapshots the env at
// `pm2 start` and a plain `pm2 restart` replays it) silently wins over the .env
// file. If config changes appear not to take effect, that's the first thing to
// check — `pm2 restart <app> --update-env`, or compare the boot-time config
// echo below against the file. Deliberately NOT `override: true`: that would
// let a stale .env clobber a correct injected value, and SQUARE_ENV in
// particular decides live-vs-sandbox AND the charge currency (AUD vs USD).
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = require('./app');
const connectDB = require('./config/db');
const { startScheduler } = require('./services/schedulerService');
const { setupSocket } = require('./socket');

const PORT = process.env.PORT || 5000;

/**
 * Echo the URL-shaped config the process actually booted with. These are the
 * values that silently break integrations when they go stale — a wrong
 * API_PUBLIC_URL kills the campaign open-pixel and every emailed RTO document
 * link, and a wrong Square notification URL fails every webhook signature.
 * Printed at boot so the running values are checkable from the log instead of
 * inferred from a provider's failure email. Secrets are shown as set/MISSING.
 */
const logRuntimeConfig = () => {
  const squareWebhookUrl =
    process.env.SQUARE_WEBHOOK_URL ||
    `${(process.env.API_PUBLIC_URL || process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '')}/api/webhooks/square/payments (derived)`;

  console.log('── runtime config ──');
  console.log(`  NODE_ENV            ${process.env.NODE_ENV || '(unset)'}`);
  console.log(`  API_PUBLIC_URL      ${process.env.API_PUBLIC_URL || '(unset)'}`);
  console.log(`  APP_BASE_URL        ${process.env.APP_BASE_URL || '(unset)'}`);
  console.log(`  SQUARE_ENV          ${process.env.SQUARE_ENV || '(unset)'}`);
  console.log(`  Square webhook URL  ${squareWebhookUrl}`);
  console.log(
    `  Square sig key      ${process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ? 'set' : 'MISSING'}`
  );
  console.log('────────────────────');
};

const start = async () => {
  await connectDB();

  const server = http.createServer(app);
  setupSocket(server);

  server.listen(PORT, () => {
    console.log(`Certified Australia backend running on port ${PORT}`);
    console.log(`Socket.io attached and ready`);
    logRuntimeConfig();
    // Start cron schedulers after DB connection and server ready
    startScheduler();
  });
};

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
