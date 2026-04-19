module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', [
      // Product scopes
      'engine',
      'desktop',
      'relay',
      'ios',
      // Repository-level
      'repo',
      'docs',
      'ci',
      'deps'
    ]],
    'scope-empty': [2, 'never']
  },
  ignores: [
    // Allow release-damnit's scope-less version commits
    (message) => message.startsWith('chore: release'),
    // Allow Dependabot
    (message) => message.startsWith('chore(deps):'),
  ]
};
