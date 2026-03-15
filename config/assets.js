/* eslint comma-dangle:[0, "only-multiline"] */
export default {
  allJS: ['server.js', 'config/**/*.js', 'lib/**/*.js', 'modules/*/**/*.js'],
  allYaml: 'modules/*/doc/*.yml',
  mongooseModels: 'modules/*/models/*.mongoose.js',
  sequelizeModels: 'modules/*/models/*.sequelize.js',
  preRoutes: 'modules/*/routes/*.preroute.js',
  routes: 'modules/*/routes/!(*.preroute).js',
  config: 'modules/*/*.init.js',
  policies: 'modules/*/policies/*.js',
};
