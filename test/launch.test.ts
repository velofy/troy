import { describe, it, expect, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'

/**
 * launch.mjs restarts a stale automation browser by killing exactly the
 * process started on the profile it manages. The kill pattern is anchored to
 * the end of the --user-data-dir argument, so a profile whose path merely
 * starts with the same characters (…/helium vs …/helium-2) is not killed
 * too. That is a process-safety rule, so it is asserted against real
 * processes rather than by inspecting a string.
 *
 * pgrep/pkill exist on macOS and Linux; on Windows launch.mjs's restart
 * path cannot run either, so the suite skips there rather than faking it.
 */
const probe = spawnSync('pgrep', ['-f', 'no-such-troy-marker'])
const hasPgrep = probe.error === undefined

describe.skipIf(!hasPgrep)('the stale-browser kill pattern', () => {
  const base = `${tmpdir()}/troy-pgrep-${process.pid}/helium`
  // A shell whose argv carries the profile flag as a positional (the script
  // itself is just a sleep), which is the shape of --user-data-dir sitting
  // in a browser's command line, without depending on which coreutils a
  // machine happens to ship.
  const fake = (profile: string) =>
    spawn('sh', ['-c', 'sleep 30', 'sh', `--user-data-dir=${profile}`])
  const exact = fake(base)
  const longer = fake(`${base}-2`)

  afterAll(() => {
    exact.kill()
    longer.kill()
  })

  const pgrep = (pattern: string): string => {
    const res = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    return res.stdout ?? ''
  }

  async function untilListed(procs: ChildProcess[]): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      // The leading [-] keeps pgrep from reading the pattern as its own
      // option: a pattern that starts with "--" is argv, not ERE, to getopt.
      const listed = pgrep(`[-]-user-data-dir=${base}`)
      if (procs.every((p) => p.pid !== undefined && listed.includes(String(p.pid)))) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('the fake browsers never appeared in the process table')
  }

  it('matches the process on the exact profile argument', async () => {
    await untilListed([exact])
    expect(pgrep(`user-data-dir=${base}($| )`)).toContain(String(exact.pid))
  })

  it('does not kill a profile whose path merely starts the same', async () => {
    await untilListed([exact, longer])
    expect(pgrep(`user-data-dir=${base}($| )`)).not.toContain(String(longer.pid))
  })
})
