/**
 * A server that is already listening, for supertest.
 *
 * Layer: e2e support, shared by the e2e specs.
 *
 * supertest starts the server it is handed when that server is not listening, and closes it once
 * its pending requests settle. A spec that sends requests one after another to such a server
 * therefore binds a new listener on a new port for every request: fifty sequential requests used
 * fifty ports, and a loop of thousands exhausts the ephemeral range under load (`EADDRNOTAVAIL`).
 * A server that is already listening is left alone, so one listener serves every request.
 *
 * The listener binds `127.0.0.1` for the reason `loopback-listen.ts` gives.
 */
import type { INestApplication } from '@nestjs/common'
import type { Server } from 'node:http'

import { LOOPBACK_HOST } from './loopback-listen'

/**
 * Starts the application's HTTP server on an ephemeral loopback port, unless it is already
 * listening, and returns it, so that `request(server)` never starts or closes a listener of its
 * own. `app.close()` still closes it.
 *
 * @param app - An application on the Express adapter, initialised or not.
 * @returns The listening `http.Server`.
 */
export async function listeningServer(app: INestApplication): Promise<Server> {
  const server = app.getHttpServer() as Server
  if (!server.listening) {
    await app.listen(0, LOOPBACK_HOST)
  }
  return server
}
