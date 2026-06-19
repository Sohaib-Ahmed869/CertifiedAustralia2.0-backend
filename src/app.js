const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const squareWebhookRoutes = require('./routes/webhooks/squareRoutes');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(helmet());
app.use(cors());
app.use('/api/webhooks/square', squareWebhookRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
  })
);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'certified-australia-backend' });
});

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
