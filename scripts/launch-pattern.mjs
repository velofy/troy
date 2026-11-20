// Pure ERE pattern builder for launch.mjs's stale-browser restart path, kept
// in its own module so unit and process tests can exercise the exact pattern
// launch.mjs hands to `pkill -f` without executing launch.mjs's CLI entrypoint.

const ERE_META = /[.^$*+?()[\]{}|\\]/g;

/**
 * Escape POSIX Extended Regular Expression (ERE) metacharacters so a literal
 * path (which commonly includes `.`, e.g. `.apply-fill`, and may include `+`,
 * `(`, `)`, `[`, `]`, `|`, etc.) matches only itself in `pkill -f` / `pgrep -f`.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeEre(value) {
  return value.replace(ERE_META, '\\$&');
}

/**
 * Build the anchored `pkill -f` / `pgrep -f` ERE pattern matching only the
 * browser process started with `--user-data-dir=<profile>`.
 *
 * @param {string} profile
 * @returns {string}
 */
export function profileKillPattern(profile) {
  return `user-data-dir=${escapeEre(profile)}($| )`;
}
