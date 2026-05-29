/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const User = mongoose.model('User');

/**
 * @desc Function to get all user in db
 * @return {Array} All users
 */
const team = () => User.find({ roles: 'admin' }, 'firstName lastName bio position avatar -_id').lean().sort('-createdAt').exec();

export default {
  team,
};
