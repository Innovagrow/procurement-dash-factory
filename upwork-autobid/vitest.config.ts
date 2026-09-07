import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The parent repository has its own postcss.config.mjs; Vite searches upward
  // and would try to load Tailwind, which this service does not depend on.
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
