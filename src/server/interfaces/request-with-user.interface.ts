/**
 * Express request augmented with an optional authenticated user.
 *
 * Layer: server/interfaces — an internal contract shared by the HTTP interceptor
 * and exception filter to read `req.user?.id` for the acting-user log field.
 * Upstream auth (guards / middleware in the consumer app) populates `user`; the
 * shape is intentionally minimal (only `id` is read). NOT re-exported from the
 * package barrel — it is an implementation detail.
 */
import type { Request } from 'express'

/** An Express request that may carry an authenticated user with an `id`. */
export type RequestWithUser = Request & { user?: { id?: string } }
