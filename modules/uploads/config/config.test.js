const config = {
  uploads: {
    avatar: {
      limits: {
        fileSize: 0.05 * 1024 * 1024, // Max file size in bytes (~50 KB)
      },
    },
  },
};

export default config;
