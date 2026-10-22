import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  SurfaceAdminService, isValidIdentity, isSupportedSurface, isValidHarnessId, sanitizeGroupId, agentDataDir,
} from '../surface-admins'
import { Storage } from '../storage'

// Each test gets an isolated fake $HOME (for agent .env files) and an isolated
// Storage base dir (for harnesses.json). No Docker, no real home touched.
let home: string
let dataDir: string
let storage: Storage
let audit: { append: ReturnType<typeof vi.fn> }
let svc: SurfaceAdminService

function writeAgentEnv(harnessName: string, content: string) {
  const agentDir = harnessName === 'personal'
    ? path.join(home, '.hermes')
    : path.join(home, `.hermes-${harnessName}`)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, '.env'), content)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-home-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-data-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  storage = new Storage(dataDir)
  audit = { append: vi.fn() }
  svc = new SurfaceAdminService(storage, audit as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('isValidIdentity', () => {
  it('accepts a Signal UUID and a phone number', () => {
    expect(isValidIdentity('signal', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true)
    expect(isValidIdentity('signal', '+6421234567')).toBe(true)
  })
  it('accepts a Telegram numeric id', () => {
    expect(isValidIdentity('telegram', '123456789')).toBe(true)
    expect(isValidIdentity('telegram', '-1001234567')).toBe(true)
  })
  it('holds Discord to the canonical snowflake bound (15–21 digits, from the registry)', () => {
    expect(isValidIdentity('discord', '123456789012345678')).toBe(true) // 18-digit snowflake
    expect(isValidIdentity('discord', '123456789012345')).toBe(true) // 15 — canonical floor
    expect(isValidIdentity('discord', '123456789012345678901')).toBe(true) // 21 — canonical ceiling
    // The old hand-rolled bound (5–25) accepted these; the canonical
    // registry pattern — now the single source — rejects them.
    expect(isValidIdentity('discord', '12345')).toBe(false)
    expect(isValidIdentity('discord', '1234567890123456789012')).toBe(false) // 22
  })
  it('rejects the wildcard, empty, and separator/control chars', () => {
    expect(isValidIdentity('signal', '*')).toBe(false)
    expect(isValidIdentity('signal', '')).toBe(false)
    expect(isValidIdentity('signal', '+64123,+64999')).toBe(false)
    expect(isValidIdentity('telegram', '123\n456')).toBe(false)
    expect(isValidIdentity('telegram', 'KEY=val')).toBe(false)
  })
  it('rejects non-strings and unsupported platforms', () => {
    expect(isValidIdentity('signal', 42 as never)).toBe(false)
    expect(isValidIdentity('whatsapp', '+64123')).toBe(false)
  })
})

describe('isSupportedSurface', () => {
  it('knows the five gateway surfaces and rejects others', () => {
    for (const p of ['signal', 'telegram', 'mattermost', 'discord', 'slack']) {
      expect(isSupportedSurface(p)).toBe(true)
    }
    expect(isSupportedSurface('whatsapp')).toBe(false)
  })
})

describe('SurfaceAdminService.listAdmins — default to allowlist (no regression)', () => {
  it('falls back to the DM allowlist when no explicit list is set', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111,aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n')
    const list = svc.listAdmins('h_seraph', 'signal')
    expect(list.source).toBe('allowlist')
    expect(list.admins).toEqual(['+64111', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'])
    expect(list.allowAllDm).toBe(false)
  })

  it('reports allowAllDm and yields ZERO admins for a wildcard allowlist', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=*\n')
    const list = svc.listAdmins('h_seraph', 'signal')
    expect(list.admins).toEqual([])
    expect(list.allowAllDm).toBe(true)
  })

  it('returns the explicit list (source: explicit) once one is stored', () => {
    storage.write('harnesses.json', [
      { id: 'h_seraph', surfaceAdmins: { signal: ['+64777'] } },
    ])
    const list = svc.listAdmins('h_seraph', 'signal')
    expect(list.source).toBe('explicit')
    expect(list.admins).toEqual(['+64777'])
  })

  it('finds the explicit list when called with the bare agent slug', () => {
    // Agents call with HERMES_AGENT_NAME (e.g. "seraph-doer"), not "h_seraph_doer".
    // Before id normalization the overlay lookup missed every explicit list for
    // agent-side calls and silently fell back to the allowlist bootstrap.
    storage.write('harnesses.json', [
      { id: 'h_seraph_doer', surfaceAdmins: { signal: ['+64777'] } },
    ])
    const list = svc.listAdmins('seraph-doer', 'signal')
    expect(list.source).toBe('explicit')
    expect(list.admins).toEqual(['+64777'])
  })

  it('a slug-keyed write lands on the h_ overlay, not a ghost entry', () => {
    // Writes must normalize like reads: before this, a setAdmins under a bare
    // slug created a NEW {id: 'seraph-doer'} overlay invisible to every
    // normalized read — the read/write drift class the registry exists to kill.
    writeAgentEnv('seraph-doer', 'SIGNAL_ALLOWED_USERS=+64111\n')
    storage.write('harnesses.json', [{ id: 'h_seraph_doer' }])
    const res = svc.setAdmins('seraph-doer', 'signal', ['+64111'], '+64111')
    expect(res.ok).toBe(true)
    const overlays = storage.read<Array<{ id: string; surfaceAdmins?: Record<string, string[]> }>>('harnesses.json', [])
    expect(overlays).toHaveLength(1)
    expect(overlays[0].id).toBe('h_seraph_doer')
    expect(overlays[0].surfaceAdmins?.signal).toEqual(['+64111'])
  })

  it('resolves the personal agent .env at ~/.hermes', () => {
    writeAgentEnv('personal', 'TELEGRAM_ALLOWED_USERS=555\n')
    expect(svc.listAdmins('h_personal', 'telegram').admins).toEqual(['555'])
  })
})

describe('SurfaceAdminService.isAdmin — fail closed', () => {
  it('is true for a user in the bootstrap allowlist', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111,+64222\n')
    expect(svc.isAdmin('h_seraph', 'signal', '+64222')).toBe(true)
  })

  it('is false for a user not in the allowlist', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\n')
    expect(svc.isAdmin('h_seraph', 'signal', '+64999')).toBe(false)
  })

  it('is false when the allowlist is a wildcard (allow-all DM ≠ everyone admin)', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=*\n')
    expect(svc.isAdmin('h_seraph', 'signal', '+64999')).toBe(false)
  })

  it('is false for unknown agent, empty userId, and unsupported platform', () => {
    expect(svc.isAdmin('h_ghost', 'signal', '+64111')).toBe(false)
    expect(svc.isAdmin('h_seraph', 'signal', '')).toBe(false)
    expect(svc.isAdmin('h_seraph', 'whatsapp', '+64111')).toBe(false)
  })

  it('honors an explicit list over the allowlist', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\n')
    storage.write('harnesses.json', [
      { id: 'h_seraph', surfaceAdmins: { signal: ['+64222'] } },
    ])
    // +64111 was a bootstrap admin but the explicit list replaces it.
    expect(svc.isAdmin('h_seraph', 'signal', '+64111')).toBe(false)
    expect(svc.isAdmin('h_seraph', 'signal', '+64222')).toBe(true)
  })
})

describe('SurfaceAdminService.setAdmins — authz + validation', () => {
  it('lets a bootstrap admin set the explicit list, and persists it', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\n')
    const res = svc.setAdmins('h_seraph', 'signal', ['+64222', '+64333'], '+64111')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.admins).toEqual(['+64222', '+64333'])
    const stored = storage.read<Array<{ id: string; surfaceAdmins?: Record<string, string[]> }>>('harnesses.json', [])
    expect(stored.find((h) => h.id === 'h_seraph')?.surfaceAdmins?.signal).toEqual(['+64222', '+64333'])
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ who: '+64111', what: 'surface-admins:set:signal', target: 'h_seraph' }),
    )
  })

  it('rejects a non-admin actor with 403 (no self-escalation) and does not write', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\n')
    const res = svc.setAdmins('h_seraph', 'signal', ['+64999'], '+64999')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
    expect(storage.read('harnesses.json', [])).toEqual([])
    expect(audit.append).not.toHaveBeenCalled()
  })

  it('rejects malformed identities with 400', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\n')
    const res = svc.setAdmins('h_seraph', 'signal', ['+64222', 'not,valid'], '+64111')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(400)
  })

  it('rejects a non-array body and a missing actor with 400', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\n')
    expect(svc.setAdmins('h_seraph', 'signal', 'nope' as never, '+64111')).toMatchObject({ ok: false, status: 400 })
    expect(svc.setAdmins('h_seraph', 'signal', ['+64222'], '')).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects an unsupported platform with 400', () => {
    expect(svc.setAdmins('h_seraph', 'whatsapp', ['+64222'], '+64111')).toMatchObject({ ok: false, status: 400 })
  })

  it('dedupes identities before persisting', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\n')
    const res = svc.setAdmins('h_seraph', 'signal', ['+64222', '+64222'], '+64111')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.admins).toEqual(['+64222'])
  })

  it('an actor promoted into the explicit list can then manage it', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\n')
    // Bootstrap admin adds +64222.
    svc.setAdmins('h_seraph', 'signal', ['+64111', '+64222'], '+64111')
    // Now +64222 (in the explicit list) can mutate; +64111 still can too.
    const res = svc.setAdmins('h_seraph', 'signal', ['+64222'], '+64222')
    expect(res.ok).toBe(true)
    // And the former bootstrap admin, now removed, can no longer mutate.
    const res2 = svc.setAdmins('h_seraph', 'signal', ['+64111'], '+64111')
    expect(res2.ok).toBe(false)
    if (!res2.ok) expect(res2.status).toBe(403)
  })
})

describe('SurfaceAdminService.syncFromAllowlist — store convergence', () => {
  it('is a no-op when no explicit list exists (bootstrap default already tracks the env)', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\n')
    svc.syncFromAllowlist('h_seraph', 'telegram', ['111', '222'])
    expect(storage.read('harnesses.json', [])).toEqual([])
    expect(audit.append).not.toHaveBeenCalled()
  })

  it('replaces a stale explicit list with the new allowlist', () => {
    storage.write('harnesses.json', [
      { id: 'h_seraph', surfaceAdmins: { telegram: ['999'] } },
    ])
    svc.syncFromAllowlist('h_seraph', 'telegram', ['111', '222'])
    const stored = storage.read<Array<{ id: string; surfaceAdmins?: Record<string, string[]> }>>('harnesses.json', [])
    expect(stored.find((h) => h.id === 'h_seraph')?.surfaceAdmins?.telegram).toEqual(['111', '222'])
    // The policy plane now answers from the converged list.
    expect(svc.isAdmin('h_seraph', 'telegram', '222')).toBe(true)
    expect(svc.isAdmin('h_seraph', 'telegram', '999')).toBe(false)
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ what: 'surface-admins:sync:telegram', target: 'h_seraph' }),
    )
  })

  it('drops invalid entries (raw @handles, wildcards) and dedupes — never stores an unresolved handle', () => {
    storage.write('harnesses.json', [
      { id: 'h_seraph', surfaceAdmins: { telegram: ['999'] } },
    ])
    svc.syncFromAllowlist('h_seraph', 'telegram', ['@juniper', '111', '*', '111'])
    const stored = storage.read<Array<{ id: string; surfaceAdmins?: Record<string, string[]> }>>('harnesses.json', [])
    expect(stored.find((h) => h.id === 'h_seraph')?.surfaceAdmins?.telegram).toEqual(['111'])
  })

  it('does not touch other platforms on the same overlay', () => {
    storage.write('harnesses.json', [
      { id: 'h_seraph', surfaceAdmins: { telegram: ['999'], signal: ['+64111'] } },
    ])
    svc.syncFromAllowlist('h_seraph', 'telegram', ['111'])
    const stored = storage.read<Array<{ id: string; surfaceAdmins?: Record<string, string[]> }>>('harnesses.json', [])
    expect(stored.find((h) => h.id === 'h_seraph')?.surfaceAdmins?.signal).toEqual(['+64111'])
  })

  it('ignores unsupported platforms', () => {
    storage.write('harnesses.json', [
      { id: 'h_seraph', surfaceAdmins: { telegram: ['999'] } },
    ])
    svc.syncFromAllowlist('h_seraph', 'whatsapp', ['111'])
    const stored = storage.read<Array<{ id: string; surfaceAdmins?: Record<string, string[]> }>>('harnesses.json', [])
    expect(stored.find((h) => h.id === 'h_seraph')?.surfaceAdmins?.telegram).toEqual(['999'])
  })
})

describe('SurfaceAdminService.approveGroupInvite — policy × admin matrix', () => {
  function agentEnvContent(harnessName: string): string {
    return fs.readFileSync(path.join(home, `.hermes-${harnessName}`, '.env'), 'utf-8')
  }

  it('approves and appends when policy is unset (approved-only default) and the adder is an admin', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_CHATS=\n')
    const res = svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '111')
    expect(res).toEqual({ ok: true, approved: true, updated: true })
    expect(agentEnvContent('seraph')).toContain('TELEGRAM_GROUP_ALLOWED_CHATS=-100777')
    expect(svc.isGroupAllowed('h_seraph', 'telegram', '-100777')).toBe(true)
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ who: '111', what: 'surface-groups:approve:telegram', target: 'h_seraph' }),
    )
  })

  it('rejects (approved: false, no write) when the adder is not an admin', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_CHATS=g1\n')
    const res = svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '222')
    expect(res).toMatchObject({ ok: true, approved: false })
    if (res.ok && !res.approved) expect(res.reason).toContain('not an admin')
    expect(agentEnvContent('seraph')).not.toContain('-100777')
  })

  it('approves for a non-admin when policy is allow-all, and appends', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_INVITE_POLICY=allow-all\n')
    const res = svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '222')
    expect(res).toEqual({ ok: true, approved: true, updated: true })
    expect(agentEnvContent('seraph')).toContain('TELEGRAM_GROUP_ALLOWED_CHATS=-100777')
  })

  it('rejects a non-admin under an explicit approved-only policy', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_INVITE_POLICY=approved-only\n')
    expect(svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '222')).toMatchObject({
      ok: true,
      approved: false,
    })
  })

  it('honors the explicit admin overlay for the admin check', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\n')
    storage.write('harnesses.json', [
      { id: 'h_seraph', surfaceAdmins: { telegram: ['222'] } },
    ])
    expect(svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '111')).toMatchObject({ approved: false })
    expect(svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '222')).toMatchObject({ approved: true })
  })

  it('is a no-write approval when the allowlist is the * wildcard', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_CHATS=*\n')
    const res = svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '111')
    expect(res).toEqual({ ok: true, approved: true, updated: false })
    expect(agentEnvContent('seraph')).toContain('TELEGRAM_GROUP_ALLOWED_CHATS=*')
  })

  it('is a no-write approval when the group is already listed', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_CHATS=-100777\n')
    const res = svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '111')
    expect(res).toEqual({ ok: true, approved: true, updated: false })
  })

  it('appends without clobbering existing groups', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_CHATS=-100111\n')
    svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '111')
    expect(agentEnvContent('seraph')).toContain('TELEGRAM_GROUP_ALLOWED_CHATS=-100111,-100777')
  })

  it('rejects structurally invalid group ids with 400 (env injection guard)', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\n')
    // '$'/backtick: String.replace replacement patterns ("x$`" splices the
    // preceding file content — incl. the bot token line — into the allowlist).
    for (const bad of ['*', '', 'g1,g2', 'g1\nKEY=val', 'a b', 'g#1', "g'1", 'x$`', 'x$&', 'g$1', 'g`id`']) {
      expect(svc.approveGroupInvite('h_seraph', 'telegram', bad, '111')).toMatchObject({ ok: false, status: 400 })
    }
  })

  it('inserts the allowlist value literally even if a replacement-pattern char reached the write', () => {
    // Belt-and-braces for the replacer-function fix: token line must survive
    // verbatim and the value may not splice file content.
    writeAgentEnv(
      'seraph',
      'TELEGRAM_BOT_TOKEN=secretAAA\nTELEGRAM_GROUP_ALLOWED_CHATS=-100111\nTELEGRAM_ALLOWED_USERS=111\n',
    )
    svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '111')
    const content = agentEnvContent('seraph')
    expect(content).toContain('TELEGRAM_BOT_TOKEN=secretAAA\n')
    expect(content).toContain('TELEGRAM_GROUP_ALLOWED_CHATS=-100111,-100777')
    expect(content.match(/TELEGRAM_BOT_TOKEN=/g)).toHaveLength(1)
  })

  it('rejects an oversized addedByUserId with 400 (audit-log spam guard)', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\n')
    expect(
      svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '9'.repeat(129)),
    ).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects a missing addedByUserId and an unsupported platform with 400', () => {
    writeAgentEnv('seraph', 'TELEGRAM_ALLOWED_USERS=111\n')
    expect(svc.approveGroupInvite('h_seraph', 'telegram', '-100777', '')).toMatchObject({ ok: false, status: 400 })
    expect(svc.approveGroupInvite('h_seraph', 'whatsapp', '-100777', '111')).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects when the agent .env does not exist', () => {
    expect(svc.approveGroupInvite('h_ghost', 'telegram', '-100777', '111')).toMatchObject({ ok: false, status: 400 })
  })

  it('works for signal too (shared invite-policy plumbing)', () => {
    writeAgentEnv('seraph', 'SIGNAL_ALLOWED_USERS=+64111\nSIGNAL_GROUP_INVITE_POLICY=approved-only\n')
    const res = svc.approveGroupInvite('h_seraph', 'signal', 'group.abc', '+64111')
    expect(res).toMatchObject({ ok: true, approved: true, updated: true })
    expect(agentEnvContent('seraph')).toContain('SIGNAL_GROUP_ALLOWED_USERS=group.abc')
  })
})

describe('SurfaceAdminService.isGroupAllowed', () => {
  it('is true for a listed group and for a wildcard', () => {
    writeAgentEnv('seraph', 'SIGNAL_GROUP_ALLOWED_USERS=g1,g2\n')
    expect(svc.isGroupAllowed('h_seraph', 'signal', 'g2')).toBe(true)
    writeAgentEnv('wild', 'TELEGRAM_GROUP_ALLOWED_CHATS=*\n')
    expect(svc.isGroupAllowed('h_wild', 'telegram', '-100')).toBe(true)
  })
  it('fails closed for unlisted group, unknown agent, unsupported platform', () => {
    writeAgentEnv('seraph', 'SIGNAL_GROUP_ALLOWED_USERS=g1\n')
    expect(svc.isGroupAllowed('h_seraph', 'signal', 'gX')).toBe(false)
    expect(svc.isGroupAllowed('h_ghost', 'signal', 'g1')).toBe(false)
    expect(svc.isGroupAllowed('h_seraph', 'whatsapp', 'g1')).toBe(false)
  })
})

// Ids that exist on the Mini (ls ~/.hermes-* + docker ps, 2026-10-22), the
// bare slug the policy plugin sends, and a Letta id from deploy-route tests.
const REAL_IDS = [
  'h_personal', 'h_cyborg', 'h_cyborg_public', 'h_evil_duck', 'h_garden_admin',
  'h_seraph_doer', 'h_swarm_map', 'seraph-doer', 'cyborg-public', 'h_letta_server',
  'h_letta_agent-xyz', 'h_letta_agent-3f2b9c1e-8d4a-4b6f-9e2a-1c7d5e8f0a12',
]
const TRAVERSAL_IDS = [
  'x/../.hermes-cryptids', '../.hermes-cryptids', '..', '.', '', 'h_a/b', 'h_a\\b',
  'h_a.b', '_h', '-h', 'h_a\n', 'h_a b', 'h_%2e%2e', 'h_' + 'a'.repeat(200),
]

describe('isValidHarnessId', () => {
  it('accepts every real harness id shape', () => {
    for (const id of REAL_IDS) expect(isValidHarnessId(id), id).toBe(true)
  })
  it('rejects path traversal and non-path-safe ids', () => {
    for (const id of TRAVERSAL_IDS) expect(isValidHarnessId(id), JSON.stringify(id)).toBe(false)
    expect(isValidHarnessId(undefined)).toBe(false)
    expect(isValidHarnessId(42)).toBe(false)
  })
  it('agentDataDir throws instead of resolving outside ~/.hermes-*', () => {
    expect(() => agentDataDir('x/../.hermes-cryptids')).toThrow('Invalid harness id')
    expect(agentDataDir('h_personal')).toBe(path.join(home, '.hermes'))
    expect(agentDataDir('h_evil_duck')).toBe(path.join(home, '.hermes-evil-duck'))
  })
})

describe('sanitizeGroupId', () => {
  it('trims and keeps real group ids (incl. base64 "=" padding)', () => {
    expect(sanitizeGroupId(' -100777 ')).toBe('-100777')
    expect(sanitizeGroupId('group.abc+/==')).toBe('group.abc+/==')
  })
  it('rejects newline, list separators, replacement patterns and wildcard', () => {
    for (const bad of ['g1\nEVIL=1', 'g\r1', 'a,b', '$&', 'a`b', '#c', '*', '', '9'.repeat(129), null, 7]) {
      expect(sanitizeGroupId(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('traversal ids on the agent-callable paths', () => {
  it('approveGroupInvite 400s and isGroupAllowed fails closed for a traversal id', () => {
    // A real agent .env one level up from the would-be traversal target.
    writeAgentEnv('cryptids', 'TELEGRAM_GROUP_ALLOWED_CHATS=*\nTELEGRAM_GROUP_INVITE_POLICY=allow-all\n')
    fs.mkdirSync(path.join(home, '.hermes-x'), { recursive: true })
    const evil = 'x/../.hermes-cryptids'
    expect(svc.isGroupAllowed(evil, 'telegram', '-100')).toBe(false)
    expect(svc.approveGroupInvite(evil, 'telegram', '-100', '111')).toMatchObject({
      ok: false, status: 400, error: 'Invalid harness id',
    })
    expect(svc.isAdmin(evil, 'telegram', '111')).toBe(false)
  })
})
