import { describe, it, expect, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { escapeEre, profileKillPattern } from '../scripts/launch-pattern.mjs'

describe('escapeEre & profileKillPattern', () => {
  it('leaves plain paths unchanged', () => {
    expect(escapeEre('/Users/alice/troy/helium-1_profile')).toBe('/Users/alice/troy/helium-1_profile')
  })

  it('escapes every POSIX ERE metacharacter', () => {
    expect(escapeEre('.^$*+?()[]{}|\\')).toBe('\\.\\^\\$\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\\\')
  })

  it('builds an anchored pattern with the profile path escaped', () => {
    expect(profileKillPattern('/home/u/.apply-fill/a+b(1)[2]')).toBe(
      'user-data-dir=/home/u/\\.apply-fill/a\\+b\\(1\\)\\[2\\]($| )',
    )
  })
})

/**
 * launch.mjs restarts a stale automation browser by killing exactly the
 * process started on the profile it manages. The kill pattern is anchored to
 * the end of the --user-data-dir argument and ERE-escaped, so a profile whose
 * path merely starts with the same characters (…/helium vs …/helium-2) or
 * differs at a dot/metacharacter (…/.apply-fill vs …/Xapply-fill) is not
 * killed too, and paths with metacharacters (+, (), [], {}, |) still match.
 * That is a process-safety rule, so it is asserted against real processes
 * rather than only by inspecting a string.
 *
 * pgrep/pkill exist on macOS and Linux; on Windows launch.mjs's restart
 * path cannot run either, so the suite skips there rather than faking it.
 */
const probe = spawnSync('pgrep', ['-f', 'no-such-troy-marker'])
const hasPgrep = probe.error === undefined

describe.skipIf(!hasPgrep)('the stale-browser kill pattern', () => {
  const prefix = `${tmpdir()}/troy-pgrep-${process.pid}`
  const base = `${prefix}/helium`
  const metaProfile = `${prefix}/.apply-fill/work+1(a)[2]{3}|alt`
  const dotSibling = `${prefix}/Xapply-fill/work+1(a)[2]{3}|alt`
  // A shell whose argv carries the profile flag as a positional (the script
  // itself is just a sleep), which is the shape of --user-data-dir sitting
  // in a browser's command line, without depending on which coreutils a
  // machine happens to ship.
  const fake = (profile: string) =>
    spawn('sh', ['-c', 'sleep 30', 'sh', `--user-data-dir=${profile}`])
  const exact = fake(base)
  const longer = fake(`${base}-2`)
  const meta = fake(metaProfile)
  const dotOther = fake(dotSibling)

  afterAll(() => {
    exact.kill()
    longer.kill()
    meta.kill()
    dotOther.kill()
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
      const listed = pgrep(`[-]-user-data-dir=${escapeEre(prefix)}`)
      if (procs.every((p) => p.pid !== undefined && listed.includes(String(p.pid)))) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('the fake browsers never appeared in the process table')
  }

  it('matches the process on the exact profile argument', async () => {
    await untilListed([exact])
    expect(pgrep(profileKillPattern(base))).toContain(String(exact.pid))
  })

  it('does not kill a profile whose path merely starts the same', async () => {
    await untilListed([exact, longer])
    expect(pgrep(profileKillPattern(base))).not.toContain(String(longer.pid))
  })

  it('matches a profile containing ERE metacharacters without over-matching a dot sibling', async () => {
    await untilListed([meta, dotOther])
    const matched = pgrep(profileKillPattern(metaProfile))
    expect(matched).toContain(String(meta.pid))
    expect(matched).not.toContain(String(dotOther.pid))
  })
})
