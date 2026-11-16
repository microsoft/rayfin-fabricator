import { describe, expect, it, vi } from 'vitest'
import docs from '@shared/docs-links.json'
import distribution from '@shared/distribution.json'
import { docsUrl, openDocs, type DocsLink } from './docsLinks'

describe('docs links', () => {
  it('points every link at a page of the published docs site', () => {
    expect(distribution.docsBase).toMatch(/^https:\/\/[^/]+(\/[a-z0-9-]+)*$/)
    for (const link of Object.keys(docs.links) as DocsLink[]) {
      const url = docsUrl(link)
      expect(url.startsWith(distribution.docsBase)).toBe(true)
      expect(url.slice(distribution.docsBase.length)).toMatch(/^\/docs(\/[a-z0-9-]+)*(#[a-z0-9-]+)?$/)
    }
  })

  it('opens the page in the system browser', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { openExternal }
    openDocs('deployFailed')
    expect(openExternal).toHaveBeenCalledWith(
      `${distribution.docsBase}/docs/troubleshooting/deploy#a-deploy-failed`
    )
  })
})
