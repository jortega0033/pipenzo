import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import tailwindcss from '@tailwindcss/vite';

// Bundles electron/main.ts and electron/preload.ts with esbuild and drives the Electron
// process during `vite dev` (launch + reload on change); `vite build` produces the same
// dist-electron/ output for packaging. This is the one non-boring dependency in the desktop
// app, chosen over hand-rolled esbuild+concurrently scripting because it's small,
// purpose-built for exactly this main/preload/renderer split, and needs no extra config.
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          // Substituted at build time, and read by main.ts as the second of two gates on the
          // development GitHub-credential fallback (issue #165). `app.isPackaged` alone is not a
          // security boundary — Electron derives it from the executable's *filename*, so a shipped
          // artifact that ships the stock binary un-renamed would silently re-enable the fallback.
          // This constant is baked in by the bundler and a rename cannot reach it. main.ts treats a
          // missing substitution as `false`, so failing to define it fails closed.
          define: {
            __PIPENZO_DEVELOPMENT_BUILD__: JSON.stringify(process.env.NODE_ENV !== 'production'),
          },
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external: ['electron'] },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              // Electron's sandboxed preload loader only supports CommonJS, so force .js/cjs
              // output even though the rest of this project is ESM ("type": "module").
              output: { format: 'cjs', entryFileNames: 'preload.js' },
            },
          },
        },
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
