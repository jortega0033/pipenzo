import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Static site only: no server, no backend, plain `vite build` -> dist/. See #245 -- this app is
// intentionally the lightest thing in the monorepo that still gets Tailwind v4 + React 19 the
// same way apps/desktop already does, rather than introducing a second framework.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
