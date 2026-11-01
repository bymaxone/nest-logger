/**
 * Pins how `PrettyDevDestination.onInit` diagnoses a failure of `pino-pretty`: only a failure to
 * resolve the package itself is reported as "not installed", and every other failure is
 * reported as what it is, with the original error as the `cause`.
 *
 * Layer: server/destinations, tests. Kept apart from the lifecycle spec so neither file grows
 * past the size limit.
 */
import * as escapeLogText from '../utils/escape-log-text.util'

// Each isolated import of the destination evaluates its imports again. Handing the isolated
// registry the escaping helpers already loaded keeps their module-level constants evaluated
// once, outside any test, where the helpers' own spec judges them; a mutation run would
// otherwise attribute them to the cases below, which assert nothing about them.
beforeEach(() => {
  jest.doMock('../utils/escape-log-text.util', () => escapeLogText)
})

afterEach(() => {
  jest.dontMock('../utils/escape-log-text.util')
})

describe('PrettyDevDestination', () => {
  describe('onInit failure diagnosis', () => {
    /** An error shaped the way Node shapes a resolution failure: a `code` and a message. */
    const resolutionError = (code: string, message: string): Error =>
      Object.assign(new Error(message), { code })

    /** Runs `onInit` against a pino-pretty whose import or `build` fails with `failure`. */
    const initFailure = async (failure: unknown, onBuild = false): Promise<unknown> => {
      let caught: unknown
      await jest.isolateModulesAsync(async () => {
        if (onBuild) {
          jest.doMock('pino-pretty', () => ({
            build: () => {
              throw failure
            }
          }))
        } else {
          jest.doMock('pino-pretty', () => {
            throw failure
          })
        }
        const { PrettyDevDestination: Fresh } = await import('./pretty-dev.destination')
        try {
          await new Fresh().onInit()
        } catch (error) {
          caught = error
        }
      })
      jest.dontMock('pino-pretty')
      return caught
    }

    it.each([
      [
        'a CommonJS resolution failure',
        resolutionError(
          'MODULE_NOT_FOUND',
          "Cannot find module 'pino-pretty'\nRequire stack:\n- /a.js"
        )
      ],
      [
        'an ESM resolution failure',
        resolutionError(
          'ERR_MODULE_NOT_FOUND',
          "Cannot find package 'pino-pretty' imported from /app/main.mjs"
        )
      ]
    ])('says pino-pretty is not installed for %s, and keeps the cause', async (_label, failure) => {
      /*
       * Only a failure to resolve pino-pretty ITSELF means the peer is missing, so only
       * that earns the install advice. The original error rides along as `cause` so the
       * resolution detail is not thrown away with the diagnosis.
       */
      const error = (await initFailure(failure)) as Error

      expect(error.message).toMatch(/pino-pretty is not installed/)
      expect(error.cause).toBe(failure)
    })

    it.each([
      [
        'build() throwing a RangeError',
        new RangeError('bad option'),
        true,
        /failed to start: bad option/
      ],
      [
        'a missing module INSIDE pino-pretty',
        resolutionError(
          'MODULE_NOT_FOUND',
          "Cannot find module 'dateformat'\nRequire stack:\n- /app/node_modules/pino-pretty/index.js"
        ),
        false,
        /failed to start: Cannot find module 'dateformat'/
      ],
      [
        'a non-Error value thrown by build()',
        'plain string failure',
        true,
        /failed to start: plain string failure/
      ],
      [
        'a message that names pino-pretty only after its first line',
        resolutionError(
          'MODULE_NOT_FOUND',
          "Cannot find module 'dateformat'\nCannot find module 'pino-pretty' is mentioned later"
        ),
        false,
        /failed to start: Cannot find module 'dateformat'/
      ]
    ])(
      'reports the real failure for %s, not a false "not installed"',
      async (_label, failure, onBuild, expected) => {
        /*
         * Install advice is true only when pino-pretty itself cannot be resolved. Any other
         * failure of the import or of `build()` (a bad option, a broken transitive
         * dependency) must be reported as what it is, with the original error as the
         * `cause`, because telling an operator whose package is present to install it
         * sends them away from the real problem.
         */
        const error = (await initFailure(failure, onBuild)) as Error

        expect(error.message).toMatch(expected)
        expect(error.message).not.toMatch(/is not installed/)
        expect(error.cause).toBe(failure)
      }
    )

    it(/*
     * A thrown value whose fields cannot be read is still reported, with a stand-in for
     * what it said, instead of escaping the diagnosis: a `code` getter that throws cannot
     * be classified as "pino-pretty is missing", and a value with no text form has no
     * message to quote.
     */
    'still reports a failure whose fields or text form cannot be read', async () => {
      const hostileCode = {
        get code(): never {
          throw new Error('code getter exploded')
        }
      }
      const noTextForm = Object.create(null) as unknown

      const first = (await initFailure(hostileCode, true)) as Error
      const second = (await initFailure(noTextForm, true)) as Error

      expect(first.message).toMatch(/pino-pretty failed to start: /)
      expect(first.cause).toBe(hostileCode)
      expect(second.message).toBe(
        '[PrettyDevDestination] pino-pretty failed to start: unreadable value'
      )
      expect(second.cause).toBe(noTextForm)
    })

    it(/*
     * The failure line is one line whatever the real error holds: the message is
     * routed through the same single-line escaper as every other terminal-bound
     * string, so a message with a newline cannot forge a second record.
     */
    'keeps the failure message on one line', async () => {
      const error = (await initFailure(new Error('first\n[forged entry]'), true)) as Error

      expect(error.message).not.toContain('\n')
    })
  })
})
