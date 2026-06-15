const config = {
  uploads: {
    activated: true,
    sharp: {
      // default sharp settings for all uploads
      blur: 8,
    },
    avatar: {
      kind: 'avatar',
      formats: ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'],
      limits: {
        fileSize: 1 * 1024 * 1024, // Max file size in bytes (1 MB)
      },
      sharp: {
        sizes: ['128', '256', '512', '1024'],
        operations: ['blur', 'bw', 'blur&bw'],
      },
    },
  },
  rateLimit: {
    // Guards the unauthenticated /api/uploads/images/:imageName route, which runs
    // the full sharp resize/transform pipeline on every guest request. Lives in
    // this base layer so the profile is present — and the limiter active — under
    // EVERY env, not only literal `production`. A stricter cap is applied as an
    // override in config/defaults/production.config.js.
    publicImage: {
      windowMs: 60 * 1000, // 1 min
      max: 600, // lenient in dev; production overrides to a stricter cap
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
  },
};

export default config;
