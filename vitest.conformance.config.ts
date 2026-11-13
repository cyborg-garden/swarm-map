import { defineConfig } from 'vitest/config'

// The local-only conformance run, against a real harness install.
// Usage: SWARMLAB_PI_BIN=/path/to/pi npm run conformance
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['conformance/suites/*.real.test.ts'],
    fileParallelism: false,
  },
})
