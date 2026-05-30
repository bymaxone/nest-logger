/**
 * Transparent no-op interceptor.
 *
 * Layer: server/interceptors — fills the global HTTP interceptor slot on the
 * ASYNC registration path when `http.isEnabled` is false. Because async-resolved
 * options are unknown when the providers array is built, the slot is always
 * registered and gated at the factory; this pass-through stands in when HTTP
 * logging is disabled, adding no behavior to the request pipeline.
 */
import { Injectable } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Observable } from 'rxjs'

/**
 * A `NestInterceptor` that forwards the request untouched.
 */
@Injectable()
export class PassThroughInterceptor implements NestInterceptor {
  /**
   * Forward the downstream stream without observing or modifying it.
   *
   * @param _context - The execution context (unused).
   * @param next - The downstream call handler.
   * @returns The unmodified downstream stream.
   */
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle()
  }
}
