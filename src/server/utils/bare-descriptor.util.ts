/**
 * A property descriptor with no prototype.
 *
 * Layer: server/utils. Pure. A descriptor literal inherits from `Object.prototype`, so a `get` or a
 * `set` planted there would make every `defineProperty` of the logger refuse a descriptor that holds a
 * `value`; a copy of its own keys in an object with no prototype does not.
 */

/**
 * The own keys of `descriptor` in an object that has no prototype.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param descriptor - A descriptor literal.
 * @returns The same descriptor, with nothing inherited.
 */
export function bareDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
  return Object.assign(Object.create(null) as PropertyDescriptor, descriptor)
}
