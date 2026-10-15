'use strict';
const mongoose = require('mongoose');
require('./models'); // register every schema so their unique indexes are built before we serve traffic
const env = require('./config/env');
const log = require('./utils/log');

mongoose.set('strictQuery', true);

async function connect(uri = env.mongoUri) {
  mongoose.connection.on('error', (e) => log.error('MongoDB error', { message: e.message }));
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));
  await mongoose.connect(uri, {
    autoIndex: env.autoIndex,
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 20,
  });
  if (env.autoIndex) {
    // Make sure unique indexes exist before we accept traffic (they protect money paths).
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  }
  return mongoose.connection;
}

const disconnect = () => mongoose.disconnect();

module.exports = { connect, disconnect };
