/**
 * E2E helper: parse the structured JSON log lines captured from a
 * `process.stdout.write` spy, dropping any non-JSON output (e.g. framework
 * banner text) so specs can assert on the library's NDJSON entries.
 */

/**
 * Parse the JSON entries written to a captured `process.stdout.write` spy.
 *
 * @param spy - A Jest spy on `process.stdout.write`.
 * @returns Every captured line that parsed as a JSON object.
 */
export function parseLogEntries(spy: jest.SpyInstance): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (const call of spy.mock.calls) {
    try {
      entries.push(JSON.parse(String(call[0])) as Record<string, unknown>)
    } catch {
      // Non-JSON output (framework text) — not a library log entry; skip it.
    }
  }
  return entries
}
