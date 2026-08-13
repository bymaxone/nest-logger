import { defineConfig } from 'tsup'

export default defineConfig([
  // Server entry (main) — NestJS module + Pino integration
  {
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['esm', 'cjs'],
    // Injects an `import.meta.url`-derived `__filename`/`__dirname` into the ESM
    // output. `otel-detector` resolves the optional `@opentelemetry/api` peer by
    // walking up from THIS MODULE's path, which is how Node resolution is
    // defined; without the shim that path is unknowable in the `.mjs` bundle and
    // the resolver would fall back to `process.cwd()` — the very assumption the
    // detector exists to stop relying on.
    shims: true,
    dts: true,
    tsconfig: 'tsconfig.build.json',
    outDir: 'dist',
    outExtension: ({ format }) => ({
      js: format === 'esm' ? '.mjs' : '.cjs'
    }),
    external: [/^@nestjs\//, 'reflect-metadata', 'pino', 'pino-pretty', '@opentelemetry/api'],
    target: 'node24',
    clean: false,
    splitting: false,
    treeshake: true,
    sourcemap: false
  },
  // Shared entry — types + constants (zero deps)
  {
    entry: { 'shared/index': 'src/shared/index.ts' },
    format: ['esm', 'cjs'],
    // Injects an `import.meta.url`-derived `__filename`/`__dirname` into the ESM
    // output. `otel-detector` resolves the optional `@opentelemetry/api` peer by
    // walking up from THIS MODULE's path, which is how Node resolution is
    // defined; without the shim that path is unknowable in the `.mjs` bundle and
    // the resolver would fall back to `process.cwd()` — the very assumption the
    // detector exists to stop relying on.
    shims: true,
    dts: true,
    tsconfig: 'tsconfig.build.json',
    outDir: 'dist',
    outExtension: ({ format }) => ({
      js: format === 'esm' ? '.mjs' : '.cjs'
    }),
    target: 'node24',
    clean: false,
    splitting: false,
    treeshake: true,
    sourcemap: false
  }
])
