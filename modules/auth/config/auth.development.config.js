const config = {
  auth: {
    lockout: {
      maxAttempts: 5, // lock account after N consecutive failed login attempts
      lockDuration: 30, // lock duration in minutes
    },
  },
  sign: {
    in: true, // disable signin
    up: true, // disable signup
  },
  // jwt is for token authentication
  jwt: {
    secret: 'WaosSecretKeyExampleToChnageAbsolutely', // secret for hash
    expiresIn: 7 * 24 * 60 * 60, // token expire in x sec
  },
  oAuth: {
    google: {
      // google console / api & service / identifier
      clientID: null,
      clientSecret: null,
      callbackURL: null,
    },
    apple: {
      clientID: null, // developer.apple.com service identifier
      teamID: null, // developer.apple.com team identifier
      keyID: null, // developer.apple.com private key identifier
      callbackURL: null,
      privateKeyLocation: null,
    },
  },
  // zxcvbn is used to manage password security
  zxcvbn: {
    forbiddenPasswords: ['12345678', 'azertyui', 'qwertyui', 'azertyuiop', 'qwertyuiop'], // passwords forbidden
    minSize: 8, // min password size
    maxSize: 126, // max password size
    minimumScore: 3, // min password complexity score
  },
  rateLimit: {
    auth: {
      windowMs: 15 * 60 * 1000, // 15 min
      max: 200, // 200 requests per window in dev (lenient for testing)
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
  },
};

export default config;
