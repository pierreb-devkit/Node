const config = {
  repos: [
    {
      // generate releases and changelogs list auto /api/core/changelogs /api/core/releases
      title: 'Node',
      owner: 'pierreb-devkit',
      repo: 'node',
      changelog: 'CHANGELOG.md',
      token: null,
    },
    {
      title: 'Vue',
      owner: 'pierreb-devkit',
      repo: 'vue',
      changelog: 'CHANGELOG.md',
      token: null,
    },
  ],
};

export default config;
