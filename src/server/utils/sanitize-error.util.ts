/**
 * Hardened error serialization for the structured logging error path.
 *
 * Layer: server/utils — a pure helper consumed by `HttpExceptionFilter` (and any
 * other site that must log an arbitrary thrown value). It normalizes any
 * `unknown` into a JSON-safe {@link SanitizedError} shape while defending against
 * the things that crash naive serializers on the error path: circular
 * references, runaway `cause` chains, and `AggregateError` fan-out (both depth
 * AND width). It NEVER throws — a logging concern must never crash the request
 * that produced it.
 *
 * This complements (does not replace) Pino's built-in `err` serializer: the
 * built-in stays wired for the `err` field convention, while `sanitizeError` is
 * for call sites that need cause-chain traversal, circular-reference safety, and
 * stack scrubbing.
 */

/** Default number of `cause` / `AggregateError` links walked before truncating. */
const DEFAULT_MAX_CAUSE_DEPTH = 3

/**
 * Maximum number of `AggregateError.errors` members serialized for a single node.
 * Bounds the WIDTH of the fan-out (depth is bounded separately): a `Promise.any`
 * over thousands of rejections must not turn one log call into O(N) sanitize +
 * stack-scrub work. Members past this cap collapse into a single width marker.
 */
const MAX_AGGREGATE_ERRORS = 10

/** Sentinel substituted for a value already visited while walking the graph. */
const CIRCULAR_SENTINEL = '[Circular]'

/**
 * Marker substituted for a `cause` / aggregate branch that exceeds a budget —
 * either the cause-depth budget or the aggregate-width cap. Bounds the work done
 * against pathological (or malicious) inputs.
 */
interface TruncatedMarker {
  readonly _truncated: true
  readonly _reason: 'cause-depth-exceeded' | 'aggregate-width-exceeded'
  /** Members omitted past the width cap — present only on a width marker. */
  readonly _omitted?: number
}

/**
 * JSON-safe normalization of a thrown value. Pino's `err` serializer can consume
 * it directly.
 */
export interface SanitizedError {
  /** Error constructor name, or `'UnknownError'` for non-error inputs. */
  name: string
  /** Error message, or the stringified value for non-error inputs. */
  message: string
  /** Stack trace with `node_modules/` frames removed. Omitted when absent. */
  stack?: string
  /** Sanitized `cause`, the depth marker, or the circular sentinel. */
  cause?: SanitizedChild
  /** Sanitized `AggregateError.errors`, each possibly truncated or circular. */
  errors?: SanitizedChild[]
}

/**
 * A nested sanitized value: a full {@link SanitizedError}, a truncation marker
 * (depth or width), or the circular-reference sentinel.
 */
type SanitizedChild = SanitizedError | TruncatedMarker | typeof CIRCULAR_SENTINEL

/** Options accepted by {@link sanitizeError}. */
export interface SanitizeErrorOptions {
  /**
   * Maximum number of `cause` / aggregate links to walk before substituting the
   * truncation marker. Defaults to {@link DEFAULT_MAX_CAUSE_DEPTH} (3).
   */
  maxCauseDepth?: number
}

/**
 * Normalize any thrown value into a JSON-safe {@link SanitizedError}.
 *
 * Behavior:
 *   - Non-error input → `{ name: 'UnknownError', message: String(input) }`.
 *   - `Error` (and native subclasses: `TypeError`, `RangeError`, `SyntaxError`,
 *     …) → `{ name, message, stack }` with `node_modules/` stack frames removed.
 *   - `cause` chains are walked recursively up to `maxCauseDepth`; deeper links
 *     become the depth-truncation marker.
 *   - `AggregateError.errors` are sanitized recursively under the same depth
 *     budget, and capped at {@link MAX_AGGREGATE_ERRORS} in width (the remainder
 *     collapses to a single width marker recording the omitted count).
 *   - Circular references collapse to the `'[Circular]'` sentinel.
 *   - NEVER throws: any internal failure yields `{ name: 'SanitizeFailed', … }`.
 *
 * @param err - The thrown value to sanitize (anything).
 * @param options - Optional tuning (see {@link SanitizeErrorOptions}).
 * @returns A JSON-safe error representation.
 * @example
 *   sanitizeError(new Error('boom'))
 *   // → { name: 'Error', message: 'boom', stack: '…' }
 * @example
 *   sanitizeError(new Error('outer', { cause: new Error('inner') }))
 *   // → { name: 'Error', message: 'outer', stack: '…', cause: { name: 'Error', message: 'inner', … } }
 */
export function sanitizeError(err: unknown, options?: SanitizeErrorOptions): SanitizedError {
  const maxCauseDepth = options?.maxCauseDepth ?? DEFAULT_MAX_CAUSE_DEPTH
  return toSanitizedError(err, new WeakSet<object>(), 0, maxCauseDepth)
}

/**
 * Whether a value can be read as an error.
 *
 * `instanceof Error` alone was too narrow, and the gap was a live defect. An
 * error that has ALREADY been normalized into a plain `{ name, message, stack }`
 * — which is exactly what `HttpExceptionFilter` hands to `errorStructured`, and
 * what any error crossing a process or worker boundary becomes — is not an
 * `Error` instance, so it was reported as `UnknownError` with the whole object
 * stringified into the message. The real type was lost either way: first as
 * `"Object"` from Pino's constructor-derived type, then as `"UnknownError"`
 * here.
 *
 * Structural detection also covers errors from another realm (a `vm` context, a
 * worker thread), where `instanceof` fails for reasons that have nothing to do
 * with the value being an error.
 *
 * The bar is deliberately narrow — string `name` AND string `message` — so an
 * arbitrary object does not get mistaken for an error and silently lose its
 * fields to the `{ name, message, stack }` shape.
 *
 * @param value - The candidate value.
 * @returns `true` when the value carries a readable error shape.
 */
function isErrorLike(value: unknown): value is Error {
  // No `instanceof Error` fast path. Every real `Error` carries string `name` and
  // `message` through its prototype, so the structural test below already
  // accepts one — the fast path decided nothing the structural test would not
  // have decided identically, which made it untestable code rather than a check.
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { name?: unknown; message?: unknown }
  return typeof candidate.name === 'string' && typeof candidate.message === 'string'
}

/**
 * Build a full {@link SanitizedError} for one node of the error graph. Wrapped in
 * a try/catch at every level so a hostile getter degrades only its own node
 * (to `SanitizeFailed`) instead of crashing the whole serialization.
 *
 * @param value - The candidate error value.
 * @param seen - References already visited (circular-reference guard).
 * @param depth - Current depth in the cause/aggregate graph.
 * @param maxDepth - Maximum depth to walk before truncating.
 * @returns The sanitized node (always a `SanitizedError`, never a marker).
 */
function toSanitizedError(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  maxDepth: number
): SanitizedError {
  try {
    if (!isErrorLike(value)) {
      return { name: 'UnknownError', message: String(value) }
    }

    seen.add(value)
    const result: SanitizedError = { name: value.name, message: value.message }
    if (value.stack !== undefined) {
      result.stack = scrubStack(value.stack)
    }

    const isAtDepthLimit = depth >= maxDepth
    if (value.cause !== undefined) {
      result.cause = isAtDepthLimit
        ? createDepthMarker()
        : toSanitizedChild(value.cause, seen, depth + 1, maxDepth)
    }

    const aggregated = readAggregatedErrors(value)
    if (aggregated !== undefined) {
      const capped = aggregated.slice(0, MAX_AGGREGATE_ERRORS)
      result.errors = capped.map((inner) =>
        isAtDepthLimit ? createDepthMarker() : toSanitizedChild(inner, seen, depth + 1, maxDepth)
      )
      if (aggregated.length > MAX_AGGREGATE_ERRORS) {
        result.errors.push(createWidthMarker(aggregated.length - MAX_AGGREGATE_ERRORS))
      }
    }

    return result
  } catch {
    // Never throw on the error path: the value carried a hostile getter or
    // otherwise resisted serialization. Degrade this node to a safe shape.
    return { name: 'SanitizeFailed', message: 'Failed to sanitize the thrown value' }
  }
}

/**
 * Sanitize a nested value (a `cause` or an aggregate member), collapsing a
 * already-visited reference to the circular sentinel before recursing.
 *
 * @param value - The nested candidate value.
 * @param seen - References already visited.
 * @param depth - Current depth in the graph.
 * @param maxDepth - Maximum depth to walk before truncating.
 * @returns The sanitized child, or the circular sentinel.
 */
function toSanitizedChild(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  maxDepth: number
): SanitizedChild {
  if (isObject(value) && seen.has(value)) {
    return CIRCULAR_SENTINEL
  }
  return toSanitizedError(value, seen, depth, maxDepth)
}

/**
 * Read an `AggregateError`-style `errors` array without widening to `any`.
 *
 * @param value - An error value that may carry inner errors.
 * @returns The inner errors as `unknown[]`, or `undefined` when absent.
 */
function readAggregatedErrors(value: Error): unknown[] | undefined {
  // `errors` is not on the `Error` type; read it through a structural view so
  // the members stay `unknown` rather than the `any[]` of the lib's
  // `AggregateError` declaration.
  const candidate: unknown = (value as { errors?: unknown }).errors
  return Array.isArray(candidate) ? candidate : undefined
}

/**
 * Remove `node_modules/` frames from a stack trace so logs surface app code.
 *
 * @internal Exported so the semconv `exception.stacktrace` attribute carries the
 *   SAME scrubbed stack as the legacy `err.stack`. Emitting one scrubbed and one
 *   raw would mean a consumer switching to `errorFormat: 'semconv'` silently
 *   lost the scrubbing they had. NOT re-exported by the package barrel.
 * @param stack - The raw stack trace.
 * @returns The stack with dependency frames stripped.
 * @example
 *   scrubStack('Error: boom\n at app (/srv/src/a.ts:1:1)\n at dep (/srv/node_modules/p/i.js:2)')
 *   // → 'Error: boom\n at app (/srv/src/a.ts:1:1)'
 */
export function scrubStack(stack: string): string {
  return stack
    .split('\n')
    .filter((line) => !line.includes('node_modules'))
    .join('\n')
}

/**
 * Type guard for a non-null object (the only values a `WeakSet` can track).
 *
 * @param value - The value to test.
 * @returns `true` when `value` is a non-null object.
 */
function isObject(value: unknown): value is object {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — every mutant here widens the guard to admit primitives, and the only call site gates `seen.has(value)` on a `WeakSet`, which answers `false` for a primitive regardless. The circular-reference branch is therefore not taken for any value the mutants newly admit, so the sanitized output is unchanged.
  return typeof value === 'object' && value !== null
}

/**
 * Create a depth-truncation marker for a `cause` / aggregate branch that ran
 * past the depth budget.
 *
 * @returns A new depth {@link TruncatedMarker}.
 */
function createDepthMarker(): TruncatedMarker {
  return { _truncated: true, _reason: 'cause-depth-exceeded' }
}

/**
 * Create a width-truncation marker recording how many `AggregateError` members
 * were omitted past {@link MAX_AGGREGATE_ERRORS}.
 *
 * @param omitted - Count of omitted members.
 * @returns A new width {@link TruncatedMarker}.
 */
function createWidthMarker(omitted: number): TruncatedMarker {
  return { _truncated: true, _reason: 'aggregate-width-exceeded', _omitted: omitted }
}
