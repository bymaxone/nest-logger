/**
 * The key under which the factory leaves, on the Pino instance it builds, the redactor that covers
 * the names a consumer asked to censor whatever the strategy.
 *
 * Layer: server/utils — a constant, shared by the factory that sets it and the logger service that
 * reads it. The entry text of an object message is a copy of one of its fields, and it is censored
 * under the names of that field even with `redactStrategy: 'paths'`, where the record redactor does
 * not cover names. A `Symbol`, so it is not a key of the instance anyone can write by accident and
 * not part of the public API.
 */
export const ENTRY_TEXT_REDACTOR: unique symbol = Symbol('bymax.entryTextRedactor')
