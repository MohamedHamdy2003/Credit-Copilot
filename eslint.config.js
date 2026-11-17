import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  { files: ['packages/domain/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['@nestjs/*', '@mastra/*', 'typeorm', 'pg', 'node:*', '**/infrastructure/**'] }] } },
);
