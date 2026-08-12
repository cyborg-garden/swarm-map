// Minimal OCI/Docker registry v2 client for image version-awareness (CD).
// Reads tags + digests from a public registry (GHCR by default) using the
// anonymous bearer-token flow. No push, no auth config — read-only.

export interface ParsedRef {
  registry: string // e.g. ghcr.io
  repo: string // e.g. cyborg-garden/hermes-agent-mt
  tag?: string
  digest?: string // sha256:...
}

/** Parse `ghcr.io/cyborg-garden/hermes-agent-mt:tag` or `...@sha256:...`. */
export function parseImageRef(ref: string): ParsedRef {
  let rest = ref
  let digest: string | undefined
  let tag: string | undefined
  const at = rest.indexOf('@')
  if (at >= 0) { digest = rest.slice(at + 1); rest = rest.slice(0, at) }
  // tag = last ':' AFTER the last '/' (so registry host ports aren't mistaken for tags)
  const lastSlash = rest.lastIndexOf('/')
  const colon = rest.indexOf(':', lastSlash + 1)
  if (colon >= 0) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon) }
  const firstSlash = rest.indexOf('/')
  // A registry host has a '.' or ':' in the first segment; else default to docker hub.
  const firstSeg = rest.slice(0, firstSlash < 0 ? rest.length : firstSlash)
  const hasHost = firstSlash >= 0 && (firstSeg.includes('.') || firstSeg.includes(':'))
  const registry = hasHost ? firstSeg : 'registry-1.docker.io'
  const repo = hasHost ? rest.slice(firstSlash + 1) : rest
  return { registry, repo, tag, digest }
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

export class RegistryService {
  constructor(private fetchImpl: typeof fetch = fetch) {}

  // Anonymous bearer token for `repository:<repo>:pull`. GHCR/Docker Hub both
  // 401 with a WWW-Authenticate realm; we follow it once.
  private async token(registry: string, repo: string): Promise<string | null> {
    const realm =
      registry === 'ghcr.io'
        ? `https://ghcr.io/token?scope=repository:${repo}:pull`
        : `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`
    try {
      const res = await this.fetchImpl(realm)
      if (!res.ok) return null
      const body = (await res.json()) as { token?: string; access_token?: string }
      return body.token || body.access_token || null
    } catch {
      return null
    }
  }

  private async authedGet(registry: string, repo: string, pathTail: string, accept?: string): Promise<Response | null> {
    const tok = await this.token(registry, repo)
    const headers: Record<string, string> = {}
    if (tok) headers['Authorization'] = `Bearer ${tok}`
    if (accept) headers['Accept'] = accept
    try {
      return await this.fetchImpl(`https://${registry}/v2/${repo}/${pathTail}`, { headers })
    } catch {
      return null
    }
  }

  /** All tags for a repo (best-effort; [] on failure). */
  async listTags(repo: string, registry = 'ghcr.io'): Promise<string[]> {
    const res = await this.authedGet(registry, repo, 'tags/list')
    if (!res || !res.ok) return []
    const body = (await res.json()) as { tags?: string[] }
    return Array.isArray(body.tags) ? body.tags : []
  }

  /** The image digest a tag currently resolves to (the Docker-Content-Digest header), or null. */
  async getDigest(repo: string, tag: string, registry = 'ghcr.io'): Promise<string | null> {
    const res = await this.authedGet(registry, repo, `manifests/${tag}`, MANIFEST_ACCEPT)
    if (!res || !res.ok) return null
    return res.headers.get('docker-content-digest')
  }
}
