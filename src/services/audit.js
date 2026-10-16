'use strict';
/** Records security events and warns the owner about sign-ins from a device we have not seen. Never throws. */
const { SecurityEvent, User } = require('../models');
const { hmacHex } = require('../utils/crypto');
const notify = require('./notify');
const log = require('../utils/log');

const deviceOf = (req) => {
  const id = req.get('X-Device-Id') || req.get('User-Agent') || '';
  return id ? hmacHex('device', id).slice(0, 16) : '';
};

async function record(req, userId, type, note) {
  try {
    await SecurityEvent.create({ user: userId, type, ip: req.ip, device: deviceOf(req), note });
  } catch (err) {
    log.warn('Security event failed', { message: err && err.message });
  }
}

/** Call after a successful login. The first device is remembered silently; any later new one raises an alert. */
async function loginSeen(req, user) {
  try {
    const dev = deviceOf(req);
    await record(req, user._id, 'login');
    if (!dev) return;
    const u = await User.findById(user._id).select('+knownDevices').lean();
    const known = (u && u.knownDevices) || [];
    if (known.includes(dev)) return;
    await User.updateOne({ _id: user._id }, { $push: { knownDevices: { $each: [dev], $slice: -10 } } });
    if (known.length) {
      await record(req, user._id, 'new_device');
      notify.notifyUser(user._id, {
        type: 'security',
        title: 'New sign-in',
        body: 'Your account was just signed in on a new device. If this was not you, change your password and PIN now.',
      });
    }
  } catch (err) {
    log.warn('Login audit failed', { message: err && err.message });
  }
}

module.exports = { record, loginSeen, deviceOf };
