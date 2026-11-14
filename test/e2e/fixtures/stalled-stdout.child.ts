/**
 * Child process of `stalled-stdout.e2e-spec.ts`: logs a burst to a stdout nobody reads, then reports
 * how much its resident memory grew, over the IPC channel.
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'

import { BymaxLoggerModule, PinoLoggerService } from '../../../src/server'

const lines = Number(process.env['LINES'] ?? '400000')
const maxBytes = Number(process.env['MAX_BYTES'] ?? '4194304')

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    BymaxLoggerModule.forRoot({
      service: { name: 'stalled-stdout', version: '0.0.0' },
      destinationQueue: { maxBytes }
    }),
    { logger: false }
  )
  const logger = app.get(PinoLoggerService)
  const before = process.memoryUsage().rss
  for (let i = 0; i < lines; i += 1)
    logger.info('K', `line ${String(i)} ${'x'.repeat(120)}`, 'u', { i })
  const growth = process.memoryUsage().rss - before
  process.send?.({ growth, stdoutQueued: process.stdout.writableLength }, () => process.exit(0))
}

void main()
