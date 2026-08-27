import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'node:crypto'

/**
 * Atomic write of a JSON payload to `filePath`.
 *
 * Strategy:
 * 1. Write to a temp file in the SAME directory as the destination so the
 *    subsequent rename is intra-filesystem (avoids EXDEV on macOS/Linux
 *    when /tmp is on a different mount than ~/.claude/).
 * 2. The temp file is created with mode 0o600 so apiKey material is
 *    owner-readable only from the moment it hits disk.
 * 3. Rename atomically replaces the destination.
 * 4. chmod 0o600 on the destination as a defensive fallback (umask /
 *    filesystem semantics can re-widen mode after rename).
 *
 * On any error during the write or rename, the temp file is unlinked.
 * Failures inside the cleanup branch are swallowed so the original
 * error is preserved.
 *
 * Exported as a separate module so tests can `mock.module()` it without
 * fighting Bun's built-in `fs` resolution.
 */
export function atomicWriteJson(filePath: string, payload: string): void {
  const dir = dirname(filePath)
  const tmpPath = `${dir}/.providers-${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, payload, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    renameSync(tmpPath, filePath)
    chmodSync(filePath, 0o600)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
    throw err
  }
}
