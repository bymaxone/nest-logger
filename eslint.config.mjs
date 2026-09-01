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
    // Anchored with `**/` on purpose. A flat-config ignore is ROOT-relative, so
    // `coverage/**` matches only the top-level directory — measured, a stray
    // `src/coverage/` from a jest run with the wrong cwd was being linted, three
    // files of generated reporter JavaScript. It passed, which is luck rather
    // than design: nobody wrote those files and a rule they happen to trip would
    // fail CI on vendor output. Git already ignores them; the linter now does too.
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
      // Without this mapping the graph rules below are decorative. The RESOLVER
      // decides where a specifier points; a separate DEPENDENCY PARSER decides
      // what the resolved file exports, and it skips in silence every extension
      // it cannot map — on a TypeScript project, all of them. Measured here: a
      // real two-file cycle produced `--print-config` saying `no-cycle` is [2]
      // and a lint run with exit 0 and no output; with this line, two errors.
      //
      // Only the rule that WALKS the graph needs it. `no-self-import` compares a
      // resolved path against the current file, so it fires either way and cannot
      // stand in as evidence that this mapping is present — measured both ways.
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

  // Formatting, as an ERROR and on every path the lint invocation reaches.
  //
  // It was `'warn'` on `src/**/*.ts` and absent everywhere else — measured, the
  // rule was NOT SET for specs, for `scripts/**` and for the config files. With no
  // `--max-warnings 0` a formatting violation exited 0, so `pnpm lint` never failed
  // on formatting anywhere, while `ci.yml` justified skipping the format-check job
  // on the grounds that "prettier runs via lint/pre-commit". The lint half of that
  // was not true. This makes it true rather than rewording the claim.
  //
  // `'error'` rather than `--max-warnings 0`, deliberately: that flag would also
  // promote `security/detect-object-injection`, a warning on purpose in the scripts
  // and spec blocks. Raising formatting must not silently raise an unrelated rule.
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
