import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'dist/**',
      'logs/**',
      '.Codex/**',
      'public/pdfjs/**',
      'test-results/**',
      'playwright-report/**',
      'lean/.lake/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  prettier,
);
