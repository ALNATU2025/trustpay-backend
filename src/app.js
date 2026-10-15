'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const mongoose = require('mongoose');
const env = require('./config/env');
const limits = require('./middleware/limits');
const { notFound, errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  app.set('trust proxy', env.trustProxy); // Render sits behind a proxy: needed for real client IPs
  app.disable('x-powered-by');

  app.use(helmet());
  const origins = env.corsOrigins === '*' ? '*' : env.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins, allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'], maxAge: 86400 }));
  app.use(compression());
  if (!env.isTest) {
    // Method, path, status and time only. Bodies and headers are never logged.
    app.use(morgan(':method :url :status :response-time ms', { skip: (req) => req.path === '/api/health' }));
  }

  // Keep the raw bytes: webhook signatures are computed over them.
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  // Health is registered before the rate limiter so uptime pings and app warm-ups are never throttled.
  const health = (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), db: mongoose.connection.readyState === 1 });
  app.get('/', health);
  app.get('/api/health', health);

  app.use('/api', limits.global);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const api = express.Router();
  api.use('/auth', require('./routes/auth'));
  api.use('/lookup', require('./routes/lookup'));
  api.use('/payments', require('./routes/payments'));
  api.use('/cards', require('./routes/cards'));
  api.use('/pos', require('./routes/pos'));
  api.use('/support', require('./routes/support'));
  api.use('/admin', require('./routes/admin'));
  api.use('/webhooks', require('./routes/webhooks'));
  api.use(require('./routes/catalog'));
  api.use(require('./routes/me'));
  api.use(require('./routes/transactions'));
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
