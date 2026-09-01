import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettierConfig from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import prettier from 'eslint-plugin-prettier'
import security from 'eslint-plugin-security'
import globals from 'globals'

export default [
  // Global ignores — only build artifacts and coverage, NOT config files
  {
    // Every entry is anchored with `**/`, and must stay that way. A flat-config
    // ignore is ROOT-relative, so a bare `coverage/**` excludes the top-level
    // directory and nothing else — a nested one (a jest run with the wrong cwd
    // leaves `src/coverage/`) is then linted, and generated reporter JavaScript
    // that nobody wrote can fail CI on a rule it happens to trip.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/reports/**',
      '**/.stryker-tmp/**'
    ]
  },

  // Base recommended config
  js.configs.recommended,

  // TypeScript production files (Node-only library; no DOM, no JSX)
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.node
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
      security
    },
    settings: {
      // Required for `no-cycle` below to detect anything at all. The RESOLVER
      // decides where a specifier points; a separate DEPENDENCY PARSER decides
      // what the resolved file exports, and it skips in silence every extension
      // it cannot map — on a TypeScript project, all of them. Remove this line and
      // `--print-config` still reports `no-cycle` as [2] while a real cycle lints
      // clean, so a green run proves nothing about it.
      //
      // Only the rule that WALKS the graph needs this. `no-self-import` compares a
      // resolved path against the current file and fires either way, so it cannot
      // stand in as evidence that this mapping is present.
      'import/parsers': { '@typescript-eslint/parser': ['.ts'] },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json'
        },
        node: {
          extensions: ['.js', '.ts']
        }
      }
    },
    rules: {
      // TypeScript — strict (zero `any`; explicit return types on exports)
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports'
        }
      ],
      '@typescript-eslint/no-empty-function': 'warn',

      // Code quality
      'prefer-const': 'error',
      'no-var': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Security — block dynamic code evaluation
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',

      // Security — ban bare 'crypto' and external crypto/id packages (node:crypto only).
      // This is a Bymax-wide guard-rail: even libs that do not currently use crypto
      // must reach for node: builtins, never a third-party dependency, if they ever do.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'crypto', message: "Use 'node:crypto' with the node: prefix instead." },
            { name: 'bcrypt', message: 'Use node:crypto scrypt instead.' },
            { name: 'argon2', message: 'Use node:crypto scrypt instead.' },
            { name: 'uuid', message: 'Use crypto.randomUUID() from node:crypto instead.' },
            { name: 'nanoid', message: 'Use crypto.randomBytes() from node:crypto instead.' },
            { name: 'crypto-js', message: 'Use node:crypto instead.' }
          ]
        }
      ],

      // Security plugin rules
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-possible-timing-attacks': 'error',

      // Import ordering — node: → external → internal → parent/sibling
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling'], 'index'],
          pathGroups: [
            {
              pattern: 'node:*',
              group: 'builtin',
              position: 'before'
            }
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true
          }
        }
      ],
      'import/no-cycle': 'error',
      'import/no-self-import': 'error'
    }
  },

  // Terminal-escaping utility — the one file whose REASON to exist is matching
  // control characters. `no-control-regex` catches them as accidents; here they
  // are the specification, and the ranges are covered by boundary tests. The
  // rule is turned off in config rather than with inline disable comments, per
  // the repository's zero-tolerance policy on scattered suppressions.
  {
    files: ['src/server/utils/escape-log-text.util.ts'],
    rules: {
      'no-control-regex': 'off'
    }
  },

  // Node.js scripts. `.cjs` is listed even though none exists today: `pnpm lint`
  // now reaches this directory, and a file the invocation reaches but no block
  // matches gets `js.configs.recommended` with no `globals.node` — measured, a
  // `.cjs` helper failed with "'process' is not defined", a gate failing on a
  // non-defect. A `.ts` helper here would be skipped in silence instead, which is
  // the same class again; keep scripts plain JavaScript.
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    plugins: {
      security
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'security/detect-object-injection': 'warn'
    }
  },

  // Config files (tsup.config.ts, jest.config.ts, etc.) — TS parser, no type-aware project
  {
    files: ['*.config.ts', '*.config.mjs', '*.config.js'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.node
      }
    },
    plugins: {
      security
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'crypto', message: "Use 'node:crypto' with the node: prefix instead." },
            { name: 'bcrypt', message: 'Use node:crypto scrypt instead.' },
            { name: 'argon2', message: 'Use node:crypto scrypt instead.' },
            { name: 'uuid', message: 'Use crypto.randomUUID() from node:crypto instead.' },
            { name: 'nanoid', message: 'Use crypto.randomBytes() from node:crypto instead.' },
            { name: 'crypto-js', message: 'Use node:crypto instead.' }
          ]
        }
      ],
      'security/detect-object-injection': 'warn'
    }
  },

  // Test files — Jest + Node globals, relaxed rules.
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.jest,
        ...globals.node
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-console': 'off'
    }
  },

  // Formatting is an ERROR, on every path the lint invocation reaches.
  //
  // `'error'` and not `--max-warnings 0`: that flag raises EVERY warning, and
  // `security/detect-object-injection` is a warning on purpose in the scripts and
  // spec blocks. Formatting has to be able to fail the build without dragging an
  // unrelated rule up with it.
  //
  // `ci.yml` passes `run-format-check: false` and points here for the guarantee,
  // so this rule is the only thing gating formatting in CI. It has to cover every
  // path `pnpm lint` passes — a rule declared for a path the invocation never
  // reaches gates nothing.
  //
  // Options stay in `.prettierrc`; passing them here would let the two disagree.
  {
    files: ['**/*.{ts,mjs,cjs,js}'],
    plugins: { prettier },
    rules: {
      'prettier/prettier': 'error'
    }
  },

  // Prettier disables conflicting formatting rules (must be last)
  prettierConfig
]
