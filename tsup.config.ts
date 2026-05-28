import { defineConfig } from 'tsup'

export default defineConfig([
  // Server entry (main) — NestJS module + Pino integration
  {
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['esm', 'cjs'],
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
