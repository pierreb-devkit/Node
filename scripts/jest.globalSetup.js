/**
 * Jest global setup - drops the test database before the test suite runs.
 * Replaces the gulp dropDB task that previously ran before jest.
 */
import mongoose from 'mongoose';

export default async () => {
  const config = (await import('../config/index.js')).default;
  await mongoose.connect(config.db.uri, config.db.options);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
};
