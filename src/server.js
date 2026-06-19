const path = require('path');
const http = require('http');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = require('./app');
const connectDB = require('./config/db');
const { startScheduler } = require('./services/schedulerService');
const { setupSocket } = require('./socket');

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();

  const server = http.createServer(app);
  setupSocket(server);

  server.listen(PORT, () => {
    console.log(`Certified Australia backend running on port ${PORT}`);
    console.log(`Socket.io attached and ready`);
    // Start cron schedulers after DB connection and server ready
    startScheduler();
  });
};

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
