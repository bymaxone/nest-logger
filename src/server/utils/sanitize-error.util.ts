/**
 * Hardened error serialization for the structured logging error path.
 *
 * Layer: server/utils — a pure helper consumed by `HttpExceptionFilter` (and any
 * other site that must log an arbitrary thrown value). It normalizes any
 * `unknown` into a JSON-safe {@link SanitizedError} shape while defending against
 * the three things that crash naive serializers on the error path: circular
 * references, runaway `cause` chains, and `AggregateError` fan-out. It NEVER
 * throws — a logging concern must never crash the request that produced it.
 *
 * This complements (does not replace) Pino's built-in `err` serializer: the
 * built-in stays wired for the `err` field convention, while `sanitizeError` is
 * for call sites that need cause-chain traversal, circular-reference safety, and
 * stack scrubbing.
 */

/** Default number of `cause` / `AggregateError` links walked before truncating. */
const DEFAULT_MAX_CAUSE_DEPTH = 3

/** Sentinel substituted for a value already visited while walking the graph. */
const CIRCULAR_SENTINEL = '[Circular]'

/**
 * Marker substituted for a `cause` or aggregate branch that exceeds the
 * configured depth budget. Bounds the recursion against pathological inputs.
 */
interface TruncatedMarker {
  readonly _truncated: true
  readonly _reason: 'cause-depth-exceeded'
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
 * A nested sanitized value: a full {@link SanitizedError}, the depth-truncation
 * marker, or the circular-reference sentinel.
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
 *     become the truncation marker.
 *   - `AggregateError.errors` are sanitized recursively under the same budget.
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
    if (!(value instanceof Error)) {
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
        ? createTruncatedMarker()
        : toSanitizedChild(value.cause, seen, depth + 1, maxDepth)
    }

    const aggregated = readAggregatedErrors(value)
    if (aggregated !== undefined) {
      result.errors = aggregated.map((inner) =>
        isAtDepthLimit
          ? createTruncatedMarker()
          : toSanitizedChild(inner, seen, depth + 1, maxDepth)
      )
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
 * @param stack - The raw stack trace.
 * @returns The stack with dependency frames stripped.
 */
function scrubStack(stack: string): string {
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
  return typeof value === 'object' && value !== null
}

/**
 * Create a fresh depth-truncation marker.
 *
 * @returns A new {@link TruncatedMarker}.
 */
function createTruncatedMarker(): TruncatedMarker {
  return { _truncated: true, _reason: 'cause-depth-exceeded' }
}
