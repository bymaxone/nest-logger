/**
 * E2E: a SIGTERM with Nest's shutdown hooks delivers every entry a slow stdout reader has not yet
 * taken, through a real child process.
 *
 * `process.stdout` holds what its reader has not taken. Nest closes the application on SIGTERM and
 * then raises the signal again, which ends the process, so the shutdown drain is the last chance for
 * those bytes to reach the reader. A shutdown that returns without waiting for stdout ends the process
 * with that buffer still in it: on Linux with node 24, a reader slower than the writer received 739 of
 * 30000 lines. The child logs a burst and signals itself; the parent reads its stdout slowly, parses
 * the records and checks that every entry of the burst arrived exactly once, whatever the lifecycle
 * entries around it.
 *
 * Layer: E2E, server (`DestinationRegistry`, `DefaultStdoutDestination`). Not part of the unit gate.
 */
import { fork } from 'node:child_process'
import { join } from 'node:path'

const CHILD = join(__dirname, 'fixtures', 'sigterm-shutdown.child.ts')
const LINES = 20_000
const READ_PAUSE_MS = 15

/** The `i` of every burst entry in the child's stdout, in arrival order. */
function burstIndexes(stdout: string): number[] {
  const indexes: number[] = []
  // The last piece is empty after a whole line and a cut one otherwise, which is never an entry.
  const lines = stdout.split('\n')
  lines.pop()
  for (const line of lines) {
    if (!line.includes('"SIGTERM_LINE"')) continue
    indexes.push((JSON.parse(line) as { i: number }).i)
  }
  return indexes
}

/** Run the child and read its stdout slowly; resolve with the entries that arrived and the stderr. */
function runChild(): Promise<{ delivered: number[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, LINES: String(LINES) }
    })
    let stdout = ''
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      child.stdout?.pause()
      setTimeout(() => child.stdout?.resume(), READ_PAUSE_MS)
    })
    child.on('error', reject)
    child.on('close', () => resolve({ delivered: burstIndexes(stdout), stderr }))
  })
}

describe('Logger E2E — a SIGTERM with shutdown hooks and a slow stdout reader', () => {
  jest.setTimeout(120_000)

  it('delivers every entry the application logged before the signal', async () => {
    const { delivered, stderr } = await runChild()

    expect([...delivered].sort((a, b) => a - b)).toEqual(Array.from({ length: LINES }, (_, i) => i))
    expect(stderr).not.toContain('entries still queued')
  })
})
