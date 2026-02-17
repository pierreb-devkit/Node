import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      'no-console': 'off',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off',
      'max-len': 'off',
      'no-param-reassign': 'off',
      'prefer-destructuring': ['error', { object: false, array: false }],
      'consistent-return': 'off',
      'no-underscore-dangle': 'off',
      'no-shadow': 'off',
      'operator-linebreak': 'off',
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-unassigned-vars': 'off',
    },
  },
  {
    files: ['**/*.tests.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
];
