// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { parseImageRef, RegistryService } from '../registry'

describe('parseImageRef', () => {
  it('parses ghcr ref with tag', () => {
    expect(parseImageRef('ghcr.io/cyborg-garden/hermes-agent-mt:2026-06-12')).toEqual({
      registry: 'ghcr.io', repo: 'cyborg-garden/hermes-agent-mt', tag: '2026-06-12', digest: undefined,
    })
  })
  it('parses a digest-pinned ref', () => {
    expect(parseImageRef('ghcr.io/cyborg-garden/hermes-agent-mt@sha256:abc')).toMatchObject({
      registry: 'ghcr.io', repo: 'cyborg-garden/hermes-agent-mt', digest: 'sha256:abc',
    })
  })
  it('defaults a bare repo to docker hub', () => {
    expect(parseImageRef('library/redis:7')).toMatchObject({ registry: 'registry-1.docker.io', repo: 'library/redis', tag: '7' })
  })
})

function mockFetch(handler: (url: string, init?: any) => { ok: boolean; status?: number; json?: any; headers?: Record<string, string> }) {
  return vi.fn(async (url: string, init?: any) => {
    const r = handler(url, init)
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json,
      headers: { get: (k: string) => (r.headers ?? {})[k.toLowerCase()] ?? null },
    } as unknown as Response
  })
}

describe('RegistryService', () => {
  it('lists tags via the anonymous-token flow', async () => {
    const f = mockFetch((url) => {
      if (url.includes('/token')) return { ok: true, json: { token: 't' } }
      if (url.endsWith('/tags/list')) return { ok: true, json: { tags: ['latest', '2026-06-12'] } }
      return { ok: false }
    })
    const tags = await new RegistryService(f as any).listTags('cyborg-garden/hermes-agent-mt')
    expect(tags).toEqual(['latest', '2026-06-12'])
    expect((f as any).mock.calls[0][0]).toContain('/token?scope=repository:cyborg-garden/hermes-agent-mt:pull')
  })

  it('returns the Docker-Content-Digest header for a tag', async () => {
    const f = mockFetch((url) => {
      if (url.includes('/token')) return { ok: true, json: { token: 't' } }
      if (url.includes('/manifests/')) return { ok: true, json: {}, headers: { 'docker-content-digest': 'sha256:deadbeef' } }
      return { ok: false }
    })
    expect(await new RegistryService(f as any).getDigest('cyborg-garden/hermes-agent-mt', 'latest')).toBe('sha256:deadbeef')
  })

  it('fails soft to [] / null on network error', async () => {
    const f = vi.fn(async () => { throw new Error('offline') })
    const svc = new RegistryService(f as any)
    expect(await svc.listTags('x/y')).toEqual([])
    expect(await svc.getDigest('x/y', 'latest')).toBeNull()
  })
})
