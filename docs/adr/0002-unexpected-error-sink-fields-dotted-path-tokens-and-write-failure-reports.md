# ADR 0002 — Sink adapter fields, dotted path tokens and write-failure reports

> **Status:** Proposed · **Date:** 2026-11-14 · **Applies to:** `@bymax-one/nest-logger` 1.4.x
> **Related:** QA-018, QA-019, DEC-154 · `docs/OBSERVABILITY-CONTRACT.md`

Three defects found by QA against the 1.4.17 release candidate share one fix PR. Each section
states the measurement, the decision and what the test must show failing first.

## 1. `PinoUnexpectedErrorSink` drops `repeated`, the exception's code and its details (QA-019)

**Measured.** With nest-core 1.6.10 and Redis stopped, 10 requests produced 4 `HTTP_UNEXPECTED_ERROR`
lines. The summary line that closes a window was indistinguishable from a first occurrence (no
`repeated`), so the log read two failures per code where there were five. No line carried the
exception's `code` or `details`.

**Contract read.** nest-core's `UnexpectedErrorReport` now has `readonly repeated?: number`, present
only on the summary that closes a window. For a `5xx` `HttpException` the report's `error` is the
exception as thrown. Its `getResponse()` carries `{ code, message, details }` flat, or
`{ error: { code, message, details } }` nested; nest-core's own extraction accepts both.

**Decision.**

| Field written  | Source                | Rule                                                                                                                                                                                                   |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repeated`     | `report.repeated`     | Written only when a positive safe integer; absent otherwise. The interface gains `readonly repeated?: number`.                                                                                         |
| `errorCode`    | `error.getResponse()` | Only when `getResponse` is a function and a string `code` is found on the flat or nested carrier. Capped at 128 characters.                                                                            |
| `errorDetails` | same carrier          | Only when `details` is a non-null object. Written as metadata, so it goes through the same redaction as any metadata object (the name walk under the default strategy, the path list under `'paths'`). |

- Independent of `errorOwnFields`: that option governs the serialized `err`, and these two keys are
  metadata beside it.
- The extraction is **fail-soft on its own**. A hostile `getResponse()` (a throwing getter, a
  non-object, a string response) yields no code and no details and the report is still written. It
  must never reach the outer `catch`, which would drop the whole report.
- The key names are `errorCode` and `errorDetails`, not `code` and `details`, so they cannot collide
  with a host's own metadata keys or with `err`'s serialized fields. Neither name is a reserved log
  key.
- `traceId` is still not written (the mixin stamps it); this ADR does not change that.

**Red first.** A `5xx`-shaped exception with `{ code, details: { reason, token } }` written through
the sink: the line has `errorCode`, `errorDetails.reason` and `errorDetails.token` censored. A report
with `repeated: 4` has `repeated: 4`; one without has no `repeated` key. A `getResponse` that throws
still writes the line.

## 2. A dotted credential in a path segment stays in clear (QA-018)

**Measured.** `ya29.<120>`, `v4.local.<80>`, `v2.public.<90>` and a dotted opaque
`<b64url>.<b64url>.<b64url>` were written in clear in `fullUrl`, `msg` and `url`. The undotted
token rule needs a whole segment of 32 or more characters of `[A-Za-z0-9_+/-]`; a dot breaks that,
and the extension strip removes only a suffix of up to 8 characters.

**Decision.** A segment that contains a dot is also tested one dot-separated part at a time with the
same token test as an undotted segment: 32 or more characters of the token alphabet, not slug-shaped,
not a UUID. One constant, one test, no second threshold. A segment is secret when any part is.

**Threshold, measured** on 7 credential shapes and 29 ordinary dotted values (names, versions,
hostnames, file names with slugs, hashed bundle names, UUID file names, a ULID file name). New
detections are those the 1.4.17 rule did not already make.

| Per-part minimum | Credentials caught (all 7) | New false positives                 |
| ---------------- | -------------------------- | ----------------------------------- |
| 40               | 6 of 7                     | 0                                   |
| **32**           | **7 of 7**                 | **0**                               |
| 24               | 7 of 7                     | 1 (`ULID….json`, a 26-character id) |

32 is chosen: it catches every credential shape QA planted that is long enough to be one, adds no
false positive, and is the value the undotted rule already uses. Of the 7 shapes, 1 was already
caught by 1.4.17 and 6 are new detections.

**Known limit, stated.** A token part that is lowercase letters and digits joined by `-` or `_` is
slug-shaped and stays in clear, exactly as in an undotted segment. A host closes that with
`http.secretPathSegments`.

**An existing expectation changes, on purpose.** `normalize-url.util.edges.spec.ts` asserted that a
token followed by a suffix of more than 8 characters (`<token>.abcdefghi`) is "a name and not a
token" and stays in clear. That is the dotted opaque form QA-018 reports, so the expectation now
says the token part is judged on its own and the segment is written as `:redacted`. The extension
rule itself (a suffix of up to 8 characters is stripped before the whole-segment test) is unchanged.

**Red first.** The QA tokens through `normalizeUrl`, `scrubSecretSegments` and the access-log
`fullUrl`, plus a table of the ordinary dotted values that must stay unchanged.

## 3. A refusing destination writes one stderr line per entry (DEC-154)

**Measured.** `reportWriteFailure` writes one `LOGGER_DESTINATION_WRITE_FAILED` line per failed
write. A destination that refuses under a log flood therefore turns each dropped entry into a stderr
write, which is itself a disk and CPU load. Queue-full drops already use a windowed report.

**Decision.** The same shape as the queue-full report, kept in `DestinationHealth` beside the drop
record: the first failure of a destination is reported at once, later ones in the same window are
counted, and the next report after the window carries the number counted since the last. The window
is `DROP_REPORT_INTERVAL_MS`. Shutdown says the number of failed writes per
destination when it is more than one, as it does for drops, so the total is never lost to the throttle. The failed write still
marks the destination failed for readiness at once; only the stderr line is throttled.

- `reportDestinationFailure` gains an optional count of writes not reported since the last line,
  printed as `suppressed`. Callers that do not pass it write the same bytes as today.
- No entry content and no cause beyond what the report already prints.
- The clock is `performance.now`, as for drops, so a wall-clock change cannot reopen or freeze a
  window.

**Red first.** 1000 failing writes in one window produce one line; the next window's first failure
produces a line with `suppressed: 999`; a second destination is counted separately; shutdown names
each destination's failed-write total when it is more than one.

## Not decided here

- Whether `errorDetails` should be size-capped. The metadata path has no cap today for any other
  object, and adding one for this key alone would be a second policy. If a measured line size problem
  appears, it is a separate decision about all metadata.
- The release number. That is the maintainer's to name.
