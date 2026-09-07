import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import tailwindcss from '@tailwindcss/vite';

// Bundles electron/main.ts and electron/preload.ts with esbuild and drives the Electron
// process during `vite dev` (launch + reload on change); `vite build` produces the same
// dist-electron/ output for packaging. This is the one non-boring dependency in the desktop
// app, chosen over hand-rolled esbuild+concurrently scripting because it's small,
// purpose-built for exactly this main/preload/renderer split, and needs no extra config.
export default defineConfig(({ command }) => ({
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
          //
          // Keyed on `command`, not on `process.env.NODE_ENV`: Vite does not reliably set NODE_ENV
          // before evaluating this file, so the env check would read `undefined` during
          // `vite build` and bake `true` — a development flag — into the very artifact that gets
          // packaged. `command === 'build'` is the signal that actually distinguishes the two.
          //
          // The result is stronger than a gate. With the constant folded to `false`, Rollup's
          // dead-code elimination removes the fallback branch from `resolveDaemonGitHubToken`
          // outright: in `dist-electron/main.js` that function reduces to the vault lookup and a
          // `{ token: undefined, source: 'none' }` return, with no reference to an environment
          // variable left in the file. A packaged build cannot take a code path it does not
          // contain. (Verified by inspecting the built output, not inferred.)
          define: {
            __PIPENZO_DEVELOPMENT_BUILD__: JSON.stringify(command !== 'build'),
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
}));
