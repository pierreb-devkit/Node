import _ from 'lodash';

const config = await import('./development.js');

export default _.merge(config.default, {
  app: {
    title: 'Devkit Node - Test Environment',
  },
  api: {
    port: 3001,
  },
  db: {
    uri: 'mongodb://127.0.0.1:27017/NodeTest',
    debug: false,
  },
  uploads: {
    avatar: {
      limits: {
        fileSize: 0.05 * 1024 * 1024, // Max file size in bytes (1 MB)
      },
    },
  },
});
