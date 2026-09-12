// The reason Troy stays open.
//
// An uncaught exception in Electron's main process kills the whole browser:
// every tab, every logged-in session, whatever you were part-way through
// typing. macOS reports it as "Troy quit unexpectedly", and the crash log
// says only EXC_BREAKPOINT, because by then the JavaScript error that caused
// it is long gone.
//
// A browser is the wrong kind of program to die that way. One event handler
// touching a tab that has just gone away is not a reason to lose the other
// eleven tabs. So the process keeps a net under itself: the error is written
// somewhere a person can read it later, and the browser stays up.
//
// This is deliberately not a way to write sloppy handlers. Everything in
// main.js still guards what it touches. This is what catches the case nobody
// thought of, which in a program driving a whole web engine is a certainty
// rather than a possibility.

import fs from 'node:fs'
import path from 'node:path'

/** Stop the log growing without bound across a long-lived install. */
const MAX_LOG_BYTES = 512 * 1024

/**
 * One line per failure, with enough to act on and nothing that identifies
 * the pages someone was looking at.
 *
 * @param {string} scope
 * @param {unknown} err
 * @param {Date} [now]
 * @returns {string}
 */
export function formatError(scope, err, now = new Date()) {
  const when = now.toISOString()
  if (err instanceof Error) {
    const stack = err.stack ? `\n${err.stack}` : ''
    return `[${when}] ${scope}: ${err.name}: ${err.message}${stack}\n`
  }
  return `[${when}] ${scope}: ${String(err)}\n`
}

/**
 * Append to the error log, trimming it first if it has grown large.
 *
 * @param {string} file
 * @param {string} text
 */
export function appendLog(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.rmSync(file)
  } catch {
    // No log yet, which is the normal case.
  }
  fs.appendFileSync(file, text)
}

/**
 * Keep the process alive through errors nobody caught, recording each one.
 *
 * @param {object} options
 * @param {string} options.logFile where to record failures
 * @param {(scope: string, err: unknown) => void} [options.onError] extra reporting
 * @param {(file: string, text: string) => void} [options.write] injected for tests
 * @returns {() => void} removes the handlers again
 */
export function installSafetyNet({ logFile, onError, write = appendLog }) {
  /** @param {string} scope */
  const handler = (scope) => (/** @type {unknown} */ err) => {
    try {
      write(logFile, formatError(scope, err))
    } catch {
      // Losing the log must not itself take the browser down.
    }
    try {
      onError?.(scope, err)
    } catch {
      // Same.
    }
  }

  const onUncaught = handler('uncaughtException')
  const onRejection = handler('unhandledRejection')

  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)

  return () => {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onRejection)
  }
}
