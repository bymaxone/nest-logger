/**
 * E2E: a stdout nobody reads does not grow the process without limit, through a real child process.
 *
 * `process.stdout` queues in memory when its reader is slower than the writer, and Pino does not slow
 * down for it. The child logs a burst to a pipe the parent never reads and reports how much its
 * resident memory grew. Measured with 400000 lines of about 190 bytes: 289865728 bytes of growth
 * with the bound off, 69681152 with a 4 MiB bound. The assertion is a generous multiple of the bound
 * plus a fixed allowance, because resident memory also moves with the runtime, and it sits well below
 * the unbounded figure.
 *
 * Layer: E2E, server (`DefaultStdoutDestination`, `destinationToStream`). Not part of the unit gate.
 */
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'

const CHILD = join(__dirname, 'fixtures', 'stalled-stdout.child.ts')
const MIB = 1024 * 1024
const LINES = 400_000

interface Report {
  readonly growth: number
  readonly stdoutQueued: number
}

/** Run the child with the given bound and resolve with what it reported. */
function runChild(maxBytes: number): Promise<{ report: Report; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(CHILD, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, LINES: String(LINES), MAX_BYTES: String(maxBytes) }
    })
    let stderr = ''
    let report: Report | undefined
    // stdout is deliberately never read: that is the stall under test.
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('message', (message) => {
      report = message as Report
    })
    child.on('error', reject)
    child.on('exit', () => {
      if (report === undefined) reject(new Error(`the child sent no report: ${stderr}`))
      else resolve({ report, stderr })
    })
  })
}

describe('Logger E2E — a stalled stdout', () => {
  jest.setTimeout(120_000)

  it('holds the process to a multiple of the bound and says so on stderr', async () => {
    const maxBytes = 4 * MIB

    const { report, stderr } = await runChild(maxBytes)

    expect(report.growth).toBeLessThan(4 * maxBytes + 96 * MIB)
    expect(report.stdoutQueued).toBeLessThanOrEqual(maxBytes)
    expect(stderr).toMatch(/Destination "stdout-json" queue full: \d+ entries dropped/)
  })

  it('does not bound the queue at 0, which is the old behaviour', async () => {
    const { report, stderr } = await runChild(0)

    expect(report.growth).toBeGreaterThan(100 * MIB)
    expect(report.stdoutQueued).toBeGreaterThan(64 * MIB)
    expect(stderr).not.toContain('queue full')
  })
})
