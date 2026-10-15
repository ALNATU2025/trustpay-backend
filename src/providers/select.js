'use strict';
const env = require('../config/env');

/** Picks the adapter implementation for PROVIDER_MODE (`sandbox` default, or `live`). */
module.exports = function select(impl) {
  return env.providerMode === 'live' ? impl.live : impl.sandbox;
};
