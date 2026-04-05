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
};

export default config;
