/**
 * Module dependencies.
 */

import chalk from 'chalk';
import mongoose from 'mongoose';
import path from 'path';
import config from '../../config/index.js';
import configHelper from '../helpers/config.js';
import logger from './logger.js';

/**
 * @desc Resolve the effective mongoose `debug` flag.
 *  Query logging is enabled only when BOTH the config opt-in is set AND the env is
 *  dev-grade (development/test/local). Any production-grade env (the literal
 *  `production` OR a deployment env label) forces it off so verbose query logs —
 *  which can include collection/field/value detail — never run in production.
 * @param {object} [cfg=config] - application configuration object
 * @returns {boolean} effective debug flag
 */
const resolveDebug = (cfg = config) => Boolean(cfg?.db?.debug) && configHelper.isDevEnv();

/**
 * Load all mongoose related models
 */
const loadModels = async (callback) => {
  // Globbing model files
  await Promise.all(
    config.files.mongooseModels.map(async (modelPath) => {
      await import(path.resolve(modelPath));
    }),
  );

  if (callback) callback();
};

/**
 * Connect to the MongoDB server
 */
const connect = async () => {
  try {
    // Attach Node.js native Promises library implementation to Mongoose
    mongoose.Promise = Promise;
    // Requires as of 4.11.0 to opt-in to the new connect implementation
    // see: http://mongoosejs.com/docs/connections.html#use-mongo-client
    const mongoOptions = config.db.options;

    if (mongoOptions.sslCA) mongoOptions.sslCA = path.resolve(mongoOptions.sslCA);
    if (mongoOptions.sslCert) mongoOptions.sslCert = path.resolve(mongoOptions.sslCert);
    if (mongoOptions.sslKey) mongoOptions.sslKey = path.resolve(mongoOptions.sslKey);

    await mongoose.connect(config.db.uri, mongoOptions);
    mongoose.set('debug', resolveDebug(config));
    logger.info(chalk.yellow('Connected to MongoDB.'));

    return mongoose;
  } catch (err) {
    // Log Error
    logger.error(chalk.red('Could not connect to MongoDB!'));
    logger.error(err);
    throw err;
  }
};

/**
 * Disconnect from the MongoDB server
 */
const disconnect = async () => {
  await mongoose.disconnect();
  logger.info(chalk.yellow('Disconnected from MongoDB.'));
};

export default {
  loadModels,
  connect,
  disconnect,
  resolveDebug,
};
