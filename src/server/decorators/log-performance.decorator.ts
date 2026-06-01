/**
 * `@LogPerformance` method decorator.
 *
 * Layer: server/decorators — wraps an instance method to measure its execution
 * time and emit `METHOD_EXECUTION` (info) or, past the threshold,
 * `METHOD_SLOW_EXECUTION` (warn). It reads `this.logger` (a
 * {@link PinoLoggerService}); if the host has no logger it stays silent. The
 * resolved return value is forwarded unchanged and the method's own exceptions
 * are never swallowed (the timing log runs in a crash-safe `finally`).
 *
 * The wrapper is always `async`: applying it to a synchronous method changes the
 * method's effective return type to `Promise<T>` at runtime. Use it on methods
 * that are already `async` (or whose callers can await the result).
 */
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { PinoLoggerService } from '../services/pino-logger.service'

/** Default threshold (ms) above which an execution is logged as slow. */
const DEFAULT_THRESHOLD_MS = 1000

/** Host shape the wrapped method relies on for its (optional) logger. */
interface LoggerHost {
  logger?: PinoLoggerService
}

/**
 * Emit the duration entry at the level dictated by the threshold: warn
 * (`METHOD_SLOW_EXECUTION`) when slow, info (`METHOD_EXECUTION`) otherwise.
 *
 * @param logger - The structured logger to write to.
 * @param method - The qualified `Class.method` name.
 * @param duration - The measured execution time in milliseconds.
 * @param thresholdMs - The slow-execution threshold in milliseconds.
 */
function emitTimingLog(
  logger: PinoLoggerService,
  method: string,
  duration: number,
  thresholdMs: number
): void {
  if (duration > thresholdMs) {
    logger.warnStructured(
      RESERVED_LOG_KEYS.METHOD_SLOW_EXECUTION,
      `${method} took ${duration}ms (threshold ${thresholdMs}ms)`,
      undefined,
      { method, duration, thresholdMs }
    )
  } else {
    logger.info(RESERVED_LOG_KEYS.METHOD_EXECUTION, `${method} completed`, undefined, {
      method,
      duration
    })
  }
}

/**
 * Measure and log a method's execution time.
 *
 * @param thresholdMs - Duration (ms) above which the call is logged as slow.
 *   Defaults to {@link DEFAULT_THRESHOLD_MS} (1000).
 * @returns A method decorator that wraps the original implementation.
 * @remarks The wrapped method always returns a `Promise` (see the file header):
 *   apply only to async methods or callers that can await the result.
 * @example
 *   class ReportService {
 *     constructor(@InjectLogger() private readonly logger: PinoLoggerService) {}
 *
 *     @LogPerformance(500) // warn if it takes > 500ms
 *     async generateReport(): Promise<void> {}
 *   }
 */
export function LogPerformance(thresholdMs: number = DEFAULT_THRESHOLD_MS): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor): PropertyDescriptor => {
    const original = descriptor.value as (...args: unknown[]) => unknown
    const method = `${target.constructor.name}.${String(propertyKey)}`

    descriptor.value = async function (this: LoggerHost, ...args: unknown[]): Promise<unknown> {
      const start = Date.now()
      try {
        return await original.apply(this, args)
      } finally {
        const duration = Date.now() - start
        if (this.logger) {
          // A logging failure must never mask the method's own result or
          // exception. PinoLoggerService is designed not to throw, but the timing
          // log stays crash-safe regardless.
          try {
            emitTimingLog(this.logger, method, duration, thresholdMs)
          } catch {
            // Intentionally swallowed — logging must not surface over the method.
          }
        }
      }
    }

    return descriptor
  }
}
