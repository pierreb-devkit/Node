/**
 * Module dependencies.
 */

import chalk from 'chalk';
import path from 'path';

const app = await import(path.resolve('./lib/app.js'));
const { default: logger } = await import(path.resolve('./lib/services/logger.js'));

const server = app.start().catch((e) => {
  logger.error(chalk.red(`Server failed`));
  logger.error(e.message, e);
  throw e;
});

process.on('SIGINT', () => {
  logger.info(chalk.blue(' SIGINT Graceful shutdown ', new Date().toISOString()));
  app.shutdown(server);
});

process.on('SIGTERM', () => {
  logger.info(chalk.blue(' SIGTERM Graceful shutdown ', new Date().toISOString()));
  app.shutdown(server);
});
