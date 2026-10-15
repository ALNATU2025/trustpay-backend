'use strict';
const express = require('express');
const { User, Notification } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { iso } = require('../services/presenter');

const router = express.Router();
router.use(requireAuth);

const present = (n) => ({ id: String(n._id), type: n.type, title: n.title, body: n.body || '', read: !!n.readAt, createdAt: iso(n.createdAt), data: n.data || {} });

router.get(
  '/notifications',
  validate(S.notificationsQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const [rows, unread] = await Promise.all([
      Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit + 1).lean(),
      Notification.countDocuments({ user: req.user._id, readAt: { $exists: false } }),
    ]);
    res.json({ items: rows.slice(0, limit).map(present), unread, page, hasMore: rows.length > limit });
  }),
);

router.get(
  '/notifications/unread',
  asyncHandler(async (req, res) => {
    const [unread, latest] = await Promise.all([
      Notification.countDocuments({ user: req.user._id, readAt: { $exists: false } }),
      Notification.findOne({ user: req.user._id, readAt: { $exists: false } }).sort({ createdAt: -1 }).lean(),
    ]);
    res.json({ unread, latest: latest ? present(latest) : null });
  }),
);

router.post(
  '/notifications/read',
  validate(S.notificationsRead),
  asyncHandler(async (req, res) => {
    const f = { user: req.user._id, readAt: { $exists: false } };
    if (!req.body.all && req.body.ids) f._id = { $in: req.body.ids };
    await Notification.updateMany(f, { $set: { readAt: new Date() } });
    res.json({ ok: true });
  }),
);

/** The app registers its Firebase push token here (needs FCM set up; harmless otherwise). */
router.post(
  '/me/devices',
  validate(S.deviceToken),
  asyncHandler(async (req, res) => {
    await User.updateOne({ deviceTokens: req.body.token, _id: { $ne: req.user._id } }, { $pull: { deviceTokens: req.body.token } });
    await User.updateOne({ _id: req.user._id }, { $addToSet: { deviceTokens: req.body.token } });
    const u = await User.findById(req.user._id).select('+deviceTokens');
    if (u.deviceTokens.length > 5) await User.updateOne({ _id: u._id }, { $set: { deviceTokens: u.deviceTokens.slice(-5) } });
    res.json({ ok: true });
  }),
);

/** Staff choose which alerts they get (signup, funding, payment, approval, alert). */
router.get('/me/notification-prefs', (req, res) => res.json({ prefs: { signup: true, funding: true, payment: true, approval: true, alert: true, ...(req.user.notifyPrefs || {}) } }));

router.post(
  '/me/notification-prefs',
  validate(S.notifyPrefs),
  asyncHandler(async (req, res) => {
    const next = { ...(req.user.notifyPrefs || {}), ...req.body };
    await User.updateOne({ _id: req.user._id }, { $set: { notifyPrefs: next } });
    res.json({ prefs: { signup: true, funding: true, payment: true, approval: true, alert: true, ...next } });
  }),
);

module.exports = router;
