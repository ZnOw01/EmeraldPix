module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    webextensions: true
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 'latest'
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  ignorePatterns: ['dist', 'node_modules', 'coverage', 'test-results', 'playwright-report'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error'
  },
  overrides: [
    {
      files: ['*.config.ts', '.eslintrc.cjs', 'scripts/**/*.mjs'],
      env: {
        browser: false,
        node: true
      }
    },
    {
      files: ['tests/**/*.ts'],
      env: {
        browser: false,
        node: true
      },
      globals: {
        afterEach: 'readonly',
        beforeEach: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        it: 'readonly',
        test: 'readonly',
        vi: 'readonly'
      }
    }
  ]
};
