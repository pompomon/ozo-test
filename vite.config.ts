import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig } from 'vitest/config'

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'inject-service-worker-assets',
      apply: 'build',
      closeBundle() {
        const outputDirectory = join(process.cwd(), 'dist')
        const workerPath = join(outputDirectory, 'sw.js')
        const outputFiles = filesBelow(outputDirectory).filter((path) => path !== workerPath)
        const assets = outputFiles
          .map((path) => relative(outputDirectory, path).split('\\').join('/'))
          .filter((path) => path !== 'index.html')
          .sort()
        const hash = createHash('sha256')
        for (const path of outputFiles.sort()) {
          hash.update(relative(outputDirectory, path))
          hash.update(readFileSync(path))
        }
        const worker = readFileSync(workerPath, 'utf8')
          .replace('__BUILD_ID__', hash.digest('hex').slice(0, 12))
          .replace('const BUILD_ASSETS = []', `const BUILD_ASSETS = ${JSON.stringify(assets)}`)
        writeFileSync(workerPath, worker)
      },
    },
  ],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
