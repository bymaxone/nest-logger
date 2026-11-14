/**
 * End-to-end proof that a spec's sequential requests share one listener.
 *
 * Layer: e2e.
 * Goal: prove that `listeningServer` leaves supertest with a server it neither starts nor closes,
 *   so N sequential requests bind one port; and that the same requests against a server that is
 *   not listening bind one port each, which is the behaviour the helper exists to avoid. The
 *   second case is the control: if supertest stops restarting the server, it fails, and the
 *   helper is no longer needed.
 * Mocks: none. A real Nest application on the Express adapter and plain `node:http` servers.
 */
import { Controller, Get } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'

import { listeningServer } from './support/listening-server'

/** How many requests each case sends, one after another. */
const SEQUENTIAL_REQUESTS = 20

/** Answers every request with `ok`. */
@Controller('ping')
class PingController {
  @Get()
  ping(): string {
    return 'ok'
  }
}

/** Records the port of every listener a server starts. */
function recordPorts(server: Server): number[] {
  const ports: number[] = []
  server.on('listening', () => ports.push((server.address() as AddressInfo).port))
  return ports
}

describe('Sequential requests and listeners (e2e)', () => {
  let app: INestApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  /**
   * Single-listener scenario.
   *
   * The application's server is listening before the first request, so supertest dials it and
   * leaves it open: every one of the requests reaches the same port, and the server starts once.
   */
  it('serves sequential requests from the one listener the helper started', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    const server = app.getHttpServer() as Server
    const ports = recordPorts(server)

    const listening = await listeningServer(app)
    for (let sent = 0; sent < SEQUENTIAL_REQUESTS; sent += 1) {
      const response = await request(listening).get('/ping')
      expect(response.text).toBe('ok')
    }

    expect(listening).toBe(server)
    expect(ports).toHaveLength(1)
    expect(listening.listening).toBe(true)
  })

  /**
   * Restart scenario, the control.
   *
   * A server that is not listening is started for each request and closed after it, so the same
   * number of requests binds that many listeners. This is the behaviour the helper avoids; a failure
   * here means supertest changed and the helper can go.
   */
  it('starts one listener per sequential request on a server that is not listening', async () => {
    const server = createServer((_incoming, response) => {
      response.end('ok')
    })
    const ports = recordPorts(server)

    for (let sent = 0; sent < SEQUENTIAL_REQUESTS; sent += 1) {
      await request(server).get('/ping')
    }

    expect(ports).toHaveLength(SEQUENTIAL_REQUESTS)
    expect(server.listening).toBe(false)
  })
})
