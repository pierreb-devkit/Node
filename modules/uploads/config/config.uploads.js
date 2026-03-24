const config = {
  uploads: {
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
    snapshot: {
      kind: 'snapshot',
      formats: ['image/jpeg', 'image/png'],
      limits: {
        fileSize: 5 * 1024 * 1024, // Max file size in bytes (5 MB)
      },
    },
  },
};

export default config;
