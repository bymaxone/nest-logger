/**
 * E2E: a SIGTERM with Nest's shutdown hooks delivers every entry a slow stdout reader has not yet
 * taken, through a real child process.
 *
 * `process.stdout` holds what its reader has not taken. Nest closes the application on SIGTERM and
 * then raises the signal again, which ends the process, so the shutdown drain is the last chance for
 * those bytes to reach the reader. The child logs a burst and signals itself; the parent reads its
 * stdout slowly and counts the lines. Measured before the drain waited for stdout, on Linux with
 * node 24: 739 of 30000 lines arrived.
 *
 * Layer: E2E, server (`DestinationRegistry`, `DefaultStdoutDestination`). Not part of the unit gate.
 */
import { fork } from 'node:child_process'
import { join } from 'node:path'

const CHILD = join(__dirname, 'fixtures', 'sigterm-shutdown.child.ts')
const LINES = 20_000
const READ_PAUSE_MS = 15

/** Run the child and read its stdout slowly; resolve with the entries that arrived and the stderr. */
function runChild(): Promise<{ delivered: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, LINES: String(LINES) }
    })
    let delivered = 0
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const byte of chunk) if (byte === 10) delivered += 1
      child.stdout?.pause()
      setTimeout(() => child.stdout?.resume(), READ_PAUSE_MS)
    })
    child.on('error', reject)
    child.on('close', () => resolve({ delivered, stderr }))
  })
}

describe('Logger E2E — a SIGTERM with shutdown hooks and a slow stdout reader', () => {
  jest.setTimeout(120_000)

  it('delivers every entry the application logged before the signal', async () => {
    const { delivered, stderr } = await runChild()

    // The bootstrap and shutdown entries come on top of the burst.
    expect(delivered).toBeGreaterThanOrEqual(LINES)
    expect(stderr).not.toContain('entries still queued')
  })
})
