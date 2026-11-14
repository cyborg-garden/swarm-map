import { defineConfig } from 'vitest/config'

// The local-only Docker run: the same checks with the harness in a sealed
// cell, plus the checks that need one. It needs a Docker daemon on this
// machine and the two lab images:
//
//   npm run conformance:docker:build     (once for each state of the code; the only step that uses the network)
//   npm run conformance:docker
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['conformance/suites/*.docker.test.ts'],
    fileParallelism: false,
  },
})
