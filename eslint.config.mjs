export default [
  {
    files: [
      'src/net/**/*.js',
      'src/client/**/*.js',
      'scripts/s2-browser-check.mjs',
      'scripts/s2-operation-recovery.mjs',
    ],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'window',
          'document',
          'location',
          'performance',
          'WebSocket',
          'navigator',
          'PerformanceObserver',
          'setInterval',
          'clearInterval',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
  {
    files: ['scripts/*browser-check.mjs'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', localStorage: 'readonly' },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: Object.fromEntries(
        [
          'process',
          'console',
          'URL',
          'Buffer',
          'setTimeout',
          'clearTimeout',
          'fetch',
          'AbortSignal',
          'structuredClone',
          'setInterval',
          'clearInterval',
          'HARBOR_BUILD_ID',
          'HARBOR_RULES_ID',
        ].map((name) => [name, 'readonly']),
      ),
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': 'error',
      'constructor-super': 'error',
    },
  },
];
