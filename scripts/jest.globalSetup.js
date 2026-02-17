/**
 * Jest global setup - drops the test database before the test suite runs.
 * Replaces the gulp dropDB task that previously ran before jest.
 * Silently skips if MongoDB is unreachable (e.g. fresh CI environment).
 */
import mongoose from 'mongoose';

export default async () => {
  try {
    const config = (await import('../config/index.js')).default;
    await mongoose.connect(config.db.uri);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch {
    // MongoDB unreachable or drop failed — tests will run against existing state
  }
};
