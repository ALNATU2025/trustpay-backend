'use strict';
const env = require('../config/env');

module.exports = {
  mode: env.providerMode,
  sandbox: env.providerMode !== 'live',
  sms: require('./sms'),
  bank: require('./bank'),
  mobileMoney: require('./mobileMoney'),
  bills: require('./bills'),
  airtime: require('./airtime'),
  cardIssuer: require('./cardIssuer'),
  cardAcquirer: require('./cardAcquirer'),
};
