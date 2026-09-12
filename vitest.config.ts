import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The battle tests drive a real Electron process over real sockets, so
    // the 5s default is too tight for anything that navigates more than once.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One test file at a time. Several files launch real Electron windows,
    // and in parallel they race: on a machine where the Electron binary is
    // not downloaded yet, two files trigger the same download into the same
    // path at once and leave it corrupt. That failed three different ways on
    // three CI platforms (a truncated framework, a locked file, a SIGTRAP)
    // for one cause. Real windows also compete for focus, so serial is the
    // honest way to run them.
    fileParallelism: false,
  },
})
