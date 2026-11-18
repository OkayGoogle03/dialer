import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Application data access must use named placeholders so the tenant guard can count :tenantId binds.
    files: ['services/*/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // Positional placeholders bypass the tenant guard's :tenantId accounting.
        { selector: 'Literal[value=/^\\s*(SELECT|INSERT|UPDATE|DELETE)\\b[\\s\\S]*(\\$[0-9]|\\?)/i]', message: 'Use named :placeholders so the tenant guard can verify scoping.' },
        { selector: 'TemplateElement[value.raw=/^\\s*(SELECT|INSERT|UPDATE|DELETE)\\b[\\s\\S]*(\\$[0-9]|\\s\\?)/i]', message: 'Use named :placeholders so the tenant guard can verify scoping.' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
    languageOptions: { globals: { ...globals.jest } },
    // tests use a raw owner connection for assertions; the tenant guard rule targets application code
    rules: { 'no-restricted-syntax': 'off' },
  },
);
