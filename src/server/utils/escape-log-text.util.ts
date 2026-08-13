/**
 * Purpose: neutralize the characters that let log TEXT control a terminal —
 * forging what looks like a separate entry, or driving the renderer through
 * ANSI escape sequences.
 *
 * Layer: server/utils — applied at the boundary where a value stops being data
 * and becomes rendered output.
 *
 * Two sinks are exposed, not one. Measured on real bytes:
 *
 * 1. Destinations that re-render the PARSED text. `pino-pretty`, shipped here as
 *    `PrettyDevDestination`, writes the restored string straight to the
 *    terminal, so a raw break or an ANSI sequence lands as terminal input.
 * 2. The RAW NDJSON line itself, when a human reads it in a terminal. JSON
 *    escaping covers only C0 — `JSON.stringify` and Pino's serializer emit DEL,
 *    the C1 range (U+0085 NEL among them), U+2028 and U+2029 VERBATIM. Those
 *    bytes move the cursor exactly as they would anywhere else.
 *
 * Escaping at this boundary covers both, and covers every third-party
 * `ILogDestination` too. Sanitizing inside `PrettyDevDestination` would protect
 * only the destination this library happens to ship.
 */

/**
 * Characters a terminal treats as "start a new line": the two JavaScript line
 * terminators, the Unicode line/paragraph separators, and C1 NEL (U+0085).
 * They become the literal `\n` sequence — readable, and matching what JSON
 * escaping does to LF and CR. The other three are NOT escaped by JSON, which is
 * precisely why the raw NDJSON line needed this too.
 */
const LINE_TERMINATORS = new Set(['\r', '\n', '\u0085', '\u2028', '\u2029'])

/**
 * Every character unsafe in single-line text: C0 controls except TAB, DEL, the
 * C1 range (which includes NEL), and the Unicode separators.
 *
 * TAB is deliberately kept — it moves horizontally, so it cannot forge a line,
 * and callers align text with it.
 */
const UNSAFE_IN_SINGLE_LINE = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * The same set minus LF, for text that is legitimately multi-line (a stack
 * trace). CR stays in the set: alone it returns the cursor to column zero and
 * overwrites the line just drawn, which forges just as effectively as LF.
 */
const UNSAFE_IN_MULTILINE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * Render a control character as its readable `\uXXXX` escape.
 *
 * One form for every character, always four hex digits. A two-digit `\xNN` form
 * was rejected: `\x` takes exactly two digits, so U+2028 would render as
 * `\x2028`, which reads as `\x20` followed by the text `28` — a space, not a
 * separator. The four-digit form is the one JavaScript and JSON use for a code
 * point, so it is familiar; it is NOT byte-identical to what the NDJSON line
 * carries, since the backslash this produces is itself escaped on the way into
 * JSON.
 *
 * @param char - A single control character.
 * @returns The four-digit lowercase escape, e.g. `\u001b` for ESC.
 */
function toEscapeSequence(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
}

/**
 * Pin text to a single rendered line, keeping it readable.
 *
 * Line terminators become the literal `\n`; every other unsafe control
 * character becomes its `\uXXXX` escape, which is what disarms ANSI sequences —
 * `ESC E` (next line) and `ESC [` (control sequence introducer) stop being
 * control input the moment the ESC byte is no longer a byte.
 *
 * @param text - The text about to be rendered on one line.
 * @returns The same text with every line-forging character neutralized.
 * @example
 *   toSingleLineMessage('fail\nFORGED')      // → 'fail\\nFORGED'  (one line)
 *   toSingleLineMessage('fail\x1bE FORGED')  // → 'fail\\u001bE FORGED'  (ESC disarmed)
 */
export function toSingleLineMessage(text: string): string {
  return text.replace(UNSAFE_IN_SINGLE_LINE, (char) =>
    LINE_TERMINATORS.has(char) ? '\\n' : toEscapeSequence(char)
  )
}

/**
 * Neutralize control characters in text that is legitimately multi-line.
 *
 * Used for stack traces, which `pino-pretty` prints RAW rather than as a JSON
 * string. Their newlines are the point and stay untouched; everything else that
 * can drive a terminal is escaped. Without this, an attacker-supplied error
 * message reaches the terminal through `err.stack` — whose first line repeats
 * that message — even when the `msg` field is already pinned.
 *
 * @param text - Multi-line text (a stack trace).
 * @returns The text with control characters escaped and newlines preserved.
 * @example
 *   escapeControlCharacters('Error: boom\x1b[2J\n    at app (/srv/a.ts:1:1)')
 *   // → 'Error: boom\\u001b[2J\n    at app (/srv/a.ts:1:1)'  (LF kept, ESC escaped)
 */
export function escapeControlCharacters(text: string): string {
  return text.replace(UNSAFE_IN_MULTILINE, toEscapeSequence)
}
