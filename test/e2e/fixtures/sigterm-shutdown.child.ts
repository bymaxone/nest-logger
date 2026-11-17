/**
 * Child process of `sigterm-shutdown.e2e-spec.ts`: logs a burst, then receives the SIGTERM an
 * orchestrator sends, with Nest's shutdown hooks enabled. Nest closes the application and then
 * raises the signal again, which ends the process.
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'

import { BymaxLoggerModule, PinoLoggerService } from '../../../src/server'

const lines = Number(process.env['LINES'] ?? '20000')

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    BymaxLoggerModule.forRoot({ service: { name: 'sigterm-shutdown', version: '0.0.0' } }),
    { logger: false }
  )
  app.enableShutdownHooks()
  const logger = app.get(PinoLoggerService)
  for (let i = 0; i < lines; i += 1)
    logger.info('SIGTERM_LINE', `line ${String(i)} ${'x'.repeat(120)}`, 'u', { i })
  process.kill(process.pid, 'SIGTERM')
}

void main()
