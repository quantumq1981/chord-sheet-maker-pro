import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // Ignore generated / third-party output
  { ignores: ['dist/', 'node_modules/', 'public/'] },

  // TypeScript source files
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      ...tseslint.configs.recommended,
      reactPlugin.configs.flat.recommended,
      reactPlugin.configs.flat['jsx-runtime'],
    ],
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs['recommended-latest'].rules,
      // Allow intentionally-unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
    settings: {
      react: { version: 'detect' },
    },
  },

  // gpParser bridges untyped AlphaTab library objects — any is unavoidable here
  {
    files: ['src/parsers/gpParser.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Test files — relax a few rules that are noisy in test helpers
  {
    files: ['tests/**/*.{ts,mts,mjs}'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Prettier last — disables all formatting-related ESLint rules
  prettierConfig,
);
