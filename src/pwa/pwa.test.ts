import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('PWA metadata', () => {
  it('provides an installable, relative-scope manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'),
    ) as {
      display: string
      start_url: string
      scope: string
      icons: Array<{ sizes: string; purpose: string }>
    }
    expect(manifest).toMatchObject({
      display: 'standalone',
      start_url: './',
      scope: './',
    })
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]))
  })

  it('caches only HTTP app assets and waits for an explicit update message', () => {
    const worker = readFileSync(join(root, 'public/sw.js'), 'utf8')
    expect(worker).toContain("request.method !== 'GET'")
    expect(worker).toContain("event.data?.type === 'SKIP_WAITING'")
    expect(worker).toContain('const BUILD_ASSETS = []')
    expect(worker).toContain('__BUILD_ID__')
    expect(worker).not.toContain('localStorage')
    expect(worker).not.toContain('indexedDB')
    const installBlock = worker.slice(
      worker.indexOf("self.addEventListener('install'"),
      worker.indexOf("self.addEventListener('activate'"),
    )
    expect(installBlock).not.toContain('skipWaiting')
  })
})
