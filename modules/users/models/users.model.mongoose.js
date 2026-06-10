/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;
mongoose.Promise = Promise;

/**
 * User Schema
 */
const UserMongoose = new Schema(
  {
    firstName: String,
    lastName: String,
    bio: String,
    position: String,
    email: {
      type: String,
      // E3: store emails lowercased and enforce uniqueness case-INSENSITIVELY via a
      // collation index (declared below), not the inline `unique:true` (which is
      // case-sensitive — `User@x` and `user@x` would coexist and break the invite
      // single-use backstop + OAuth account-linking). lowercase:true normalizes on
      // write; the collation index is the read/uniqueness guard.
      lowercase: true,
    },
    avatar: String,
    roles: [String],
    /* Provider */
    provider: String,
    providerData: {},
    additionalProvidersData: {},
    /* Password */
    password: String,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    /* Email verification */
    emailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: String,
    emailVerificationExpires: Date,
    // startup requirement
    terms: Date,
    /* Account lockout */
    lastLoginAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    // other
    currentOrganization: {
      type: Schema.ObjectId,
      ref: 'Organization',
    },
    complementary: {}, // put your specific project private data here
  },
  {
    timestamps: true,
  },
);

// E3: case-insensitive unique email. strength:2 = case- + diacritic-insensitive
// equality, so `User@x.com` and `user@x.com` collide on insert. The migration
// (modules/users/migrations/*-users-email-ci-unique-index.js) is the AUTHORITATIVE
// creator of this index; declaring the IDENTICAL index here (same key, options,
// AND explicit name) keeps autoIndex / syncIndexes idempotent (not divergent).
// The explicit name MUST differ from the legacy default `email_1` so the collation
// index and the legacy plain index can coexist transiently — otherwise autoIndex
// tries to (re)create `email_1` with a collation while a plain `email_1` already
// exists, which Mongo rejects ("Index already exists with a different name").
// Both schema + migration converge on a single `email_ci_unique` (collation) index
// with no stray plain `email_1` left behind.
UserMongoose.index(
  { email: 1 },
  { unique: true, name: 'email_ci_unique', collation: { locale: 'en', strength: 2 } },
);

function addID() {
  return this._id.toHexString();
}
UserMongoose.virtual('id').get(addID);

// Ensure virtual fields are serialised.
UserMongoose.set('toJSON', {
  virtuals: true,
});

/**
 * Create instance method for authenticating user
 */
// UserMongoose.methods.authenticate = password => this.password === this.hashPassword(password);

// UserMongoose.static('findOneOrCreate', async (condition, doc) => {
//   const one = await this.findOne(condition);
//   return one || this.create(doc).then((document) => {
//     console.log('docteur', document);
//     return document;
//   }).catch((err) => {
//     console.log(err);
//     return Promise.resolve(doc);
//   });
// });

mongoose.model('User', UserMongoose);
