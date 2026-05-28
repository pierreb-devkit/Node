/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Invitation = mongoose.model('Invitation');

/**
 * @desc Create an invitation document
 * @param {Object} doc - { email, token, expiresAt, invitedBy }
 * @returns {Promise<Object>} created invitation
 */
const create = (doc) => new Invitation(doc).save();

/**
 * @desc Find an invitation by its token
 * @param {String} token
 * @returns {Promise<Object|null>}
 */
const findByToken = (token) => Invitation.findOne({ token }).exec();

/**
 * @desc Find the most recent unused, unexpired invitation for an email
 * @param {String} email - already-lowercased email
 * @returns {Promise<Object|null>}
 */
const findByEmail = (email) =>
  Invitation.findOne({ email, usedAt: null, expiresAt: { $gt: new Date() } })
    .sort('-createdAt')
    .exec();

/**
 * @desc Atomically mark an invitation used (single-use guard via usedAt: null filter)
 * @param {String} id
 * @returns {Promise<Object|null>} updated doc, or null if already consumed
 */
const consume = (id) =>
  Invitation.findOneAndUpdate({ _id: id, usedAt: null }, { $set: { usedAt: new Date() } }, { returnDocument: 'after' }).exec();

/**
 * @desc List all invitations (admin), newest first
 * @returns {Promise<Array>}
 */
const list = () => Invitation.find({}).select('-token').populate('invitedBy', 'email firstName lastName').sort('-createdAt').exec();

/**
 * @desc Get one invitation by id
 * @param {String} id
 * @returns {Promise<Object|null>}
 */
const get = (id) => (mongoose.Types.ObjectId.isValid(id) ? Invitation.findById(id).exec() : null);

/**
 * @desc Remove an invitation by id
 * @param {String} id
 * @returns {Promise<Object>} delete result
 */
const remove = (id) => Invitation.deleteOne({ _id: id }).exec();

export default { create, findByToken, findByEmail, consume, list, get, remove };
