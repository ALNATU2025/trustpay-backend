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
  app.use(cors({ origin: origins, allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Confirm-Duplicate'], maxAge: 86400 }));
  app.use(compression());
  if (!env.isTest) {
    // Method, path, status and time only. Bodies and headers are never logged.
    app.use(morgan(':method :url :status :response-time ms', { skip: (req) => req.path === '/api/health' }));
  }

  // Proof documents (photos / PDFs as base64) need a bigger body than normal requests.
  app.use('/api/me/documents', express.json({ limit: '5mb' }));

  // Keep the raw bytes: webhook signatures are computed over them.
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  // Health is registered before the rate limiter so uptime pings and app warm-ups are never throttled.
  const health = (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), db: mongoose.connection.readyState === 1 });
  app.get('/', health);
  app.get('/api/health', health);

  // Where Monime's hosted checkout sends the customer afterwards. Static text only; the wallet is
  // credited by the webhook, never by this page.
  app.get('/api/pay/return', (req, res) => {
    const ok = req.query.status === 'success';
    res.set('Cache-Control', 'no-store').type('html').send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TrustPay</title>` +
        `<style>body{font-family:system-ui,sans-serif;background:#f4f6fb;color:#0b1b3a;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}` +
        `.c{background:#fff;border-radius:24px;padding:32px 24px;max-width:360px;box-shadow:0 8px 30px rgba(11,27,58,.08)}h1{font-size:22px;margin:0 0 8px}p{color:#5b6781;line-height:1.5;margin:0}</style></head>` +
        `<body><div class="c"><h1>${ok ? 'Payment received' : 'Payment not completed'}</h1>` +
        `<p>${ok ? 'Your TrustPay balance will update in a moment. You can close this page and return to the app.' : 'No money was taken. You can close this page and try again in the app.'}</p></div></body></html>`,
    );
  });

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
  api.use(require('./routes/notifications'));
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
