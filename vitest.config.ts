import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The battle tests drive a real Electron process over real sockets, so
    // the 5s default is too tight for anything that navigates more than once.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
