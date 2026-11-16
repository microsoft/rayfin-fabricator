import docs from '@shared/docs-links.json'
import distribution from '@shared/distribution.json'

/**
 * Pages of the Fabricator docs site (website/) that the app links to. The site's build
 * fails if one of these routes or anchors disappears (website/scripts/verify-app-links.mts).
 * The site's address comes from src/shared/distribution.json.
 */
export type DocsLink = keyof typeof docs.links

export function docsUrl(link: DocsLink): string {
  return `${distribution.docsBase}${docs.links[link]}`
}

/** The address of any docs page (`/docs/ship/deploy`), optionally at one of its headings. */
export function docsPageUrl(path: string, anchor?: string): string {
  return `${distribution.docsBase}${path}${anchor ? `#${anchor}` : ''}`
}

/** Open a docs page in the system browser. */
export function openDocs(link: DocsLink): void {
  void window.api.openExternal(docsUrl(link))
}
