import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testIgnore: '**/*extension.spec.ts',
  use: { ...base.use, browserName: 'firefox' },
});
