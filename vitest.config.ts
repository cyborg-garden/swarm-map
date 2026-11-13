import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Nested git worktrees (`.wt-<topic>/`) are full checkouts of this repo
    // living inside it. Vitest's default include globs scoop up their test
    // files, so a run on THIS branch reports other branches' failures as its
    // own (33 of them as of 2026-08-06, none from this tree) — which makes
    // every run dishonest and trains everyone to ignore red. Excluded, not
    // deleted: these are live worktrees someone is working in.
    // `*.real.test.ts` needs a real harness installed, which CI does not have.
    // It runs through `npm run conformance` (vitest.conformance.config.ts).
    // `*.docker.test.ts` needs a Docker daemon and the lab's images, which CI
    // does not have. It runs through `npm run conformance:docker`.
    exclude: [...configDefaults.exclude, '**/.wt-*/**', 'conformance/suites/*.real.test.ts', 'conformance/suites/*.docker.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
