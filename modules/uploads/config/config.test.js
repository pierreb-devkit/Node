const config = {
  uploads: {
    avatar: {
      limits: {
        fileSize: Math.floor(0.05 * 1024 * 1024), // Max file size in bytes (~52 KB)
      },
    },
  },
};

export default config;
