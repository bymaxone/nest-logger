/**
 * E2E fixture controller.
 *
 * Exercises the full logging stack through real HTTP routes: a plain 200, a
 * parameterized route (URL normalization), an uncaught error (filter + 5xx
 * logging), and an excluded health route (must NOT log).
 */
import { Controller, Get, Param } from '@nestjs/common'
import { InjectLogger, PinoLoggerService } from '@bymax-one/nest-logger'

/** Routes covering the lifecycle paths the e2e specs assert on. */
@Controller()
export class TestController {
  constructor(@InjectLogger('TestController') private readonly logger: PinoLoggerService) {}

  /** Simple 200 — drives HTTP_REQUEST_START + HTTP_REQUEST_SUCCESS. */
  @Get('hello')
  hello(): { ok: boolean } {
    return { ok: true }
  }

  /** Parameterized route — the id must normalize to `/users/:id` in logs. */
  @Get('users/:id')
  getUser(@Param('id') id: string): { id: string } {
    this.logger.info('USER_FETCH_OK', 'fetched user', undefined, { fetchedId: id })
    return { id }
  }

  /** Throws — drives the filter + HTTP_REQUEST_SERVER_ERROR (500). */
  @Get('boom')
  boom(): never {
    throw new Error('boom in e2e')
  }

  /** Excluded path (default excludePaths) — must produce NO HTTP log. */
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' }
  }
}
