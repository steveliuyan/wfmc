import { build } from 'esbuild'
import { rmSync } from 'node:fs'

rmSync('dist/main', { recursive: true, force: true })

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // 第三方包保持运行时 require（@xmcl 内部有动态 require，不能打包）
  packages: 'external',
  external: ['electron', 'original-fs'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production')
  }
}

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js'
})

await build({
  ...common,
  bundle: true,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/main/preload.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  packages: 'external',
  sourcemap: true,
  logLevel: 'info'
})

console.log('[build-main] done')
