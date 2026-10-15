'use strict';
const mongoose = require('mongoose');
require('./models'); // register every schema so their unique indexes are built before we serve traffic
const env = require('./config/env');
const log = require('./utils/log');

mongoose.set('strictQuery', true);

async function connect(uri = env.mongoUri) {
  mongoose.connection.on('error', (e) => log.error('MongoDB error', { message: e.message }));
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));
  // Never hang silently: a stuck DNS lookup or index build must show up in the logs and fail the deploy.
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('MongoDB did not answer within 45 seconds. Check MONGODB_URI, the Atlas user password and Atlas Network Access.')), 45000);
  });
  const work = (async () => {
    log.info('Connecting to MongoDB');
    await mongoose.connect(uri, {
      autoIndex: env.autoIndex,
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      maxPoolSize: 20,
    });
    log.info('MongoDB connection open');
    if (env.autoIndex) {
      // Make sure unique indexes exist before we accept traffic (they protect money paths).
      log.info('Checking indexes');
      await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    }
    return mongoose.connection;
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const disconnect = () => mongoose.disconnect();

module.exports = { connect, disconnect };
