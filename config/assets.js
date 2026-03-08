/* eslint comma-dangle:[0, "only-multiline"] */
export default {
  allJS: ['server.js', 'config/**/*.js', 'lib/**/*.js', 'modules/*/**/*.js'],
  allYaml: 'modules/*/doc/*.yml',
  mongooseModels: 'modules/*/models/*.mongoose.js',
  sequelizeModels: 'modules/*/models/*.sequelize.js',
  routes: 'modules/*/routes/*.js',
  config: 'modules/*/config/*.config.js',
  policies: 'modules/*/policies/*.js',
};
