// The shape of a PolicyRecord, checked at run time. types.ts only binds code
// that was compiled against it; a record arrives as JSON, and JSON can say
// anything. Every closed set in types.ts is listed here once, and both
// validatePolicy() (at save) and decide() (on every decision) read it, so a
// value decide() does not recognise can never fall through to "allowed".
//
// Returns one line per problem, `<path>: <what is wrong>`. Never throws.

const POSTURES = ['private', 'team', 'public']
const MODES = ['door', 'native']
export const SURFACE_IDS = ['discord', 'signal', 'slack', 'telegram', 'mattermost', 'fake']
const ROOM_MODES = ['mention', 'free', 'ignore']
const DM_MODES = ['closed', 'allowlist', 'pairing', 'open']
const BOT_MODES = ['none', 'mentions', 'all']
const INVITE_MODES = ['closed', 'admins', 'allowlisted', 'open']
const PRINCIPAL_KINDS = ['user', 'role']
export const TOOL_CLASSES = [
  'shell', 'file_read', 'file_write', 'code_exec', 'browser', 'network', 'chat_post', 'chat_admin', 'memory', 'unknown',
]
const BROWSER_GUARDS = ['off', 'public-hosts-only']
const KEY_KINDS = ['model', 'broker', 'sidecar-tool', 'env']
const ON_EXCEED = ['refuse', 'warn']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''

export function isToolClass(v: unknown): boolean {
  return typeof v === 'string' && (TOOL_CLASSES.includes(v) || /^mcp:.+/.test(v))
}

export function shapeErrors(policy: unknown): string[] {
  const errors: string[] = []
  const bad = (path: string, want: string): void => { errors.push(`${path}: must be ${want}`) }
  const oneOf = (path: string, v: unknown, set: string[]): void => {
    if (typeof v !== 'string' || !set.includes(v)) bad(path, `one of ${set.join(', ')}`)
  }
  const bool = (path: string, v: unknown): void => { if (typeof v !== 'boolean') bad(path, 'true or false') }
  const text = (path: string, v: unknown): void => { if (typeof v !== 'string') bad(path, 'text') }
  /** Runs `each` on every item when `v` is a list; reports the path otherwise. */
  const list = (path: string, v: unknown, each: (itemPath: string, item: unknown) => void): void => {
    if (!Array.isArray(v)) return bad(path, 'a list')
    v.forEach((item, i) => each(`${path}.${i}`, item))
  }
  const obj = (path: string, v: unknown, then: (o: Obj) => void): void => {
    if (!isObj(v)) return bad(path, 'an object')
    then(v)
  }
  const texts = (path: string, v: unknown): void => list(path, v, (p, item) => { if (!isText(item)) bad(p, 'non-empty text') })
  const principals = (path: string, v: unknown): void => list(path, v, (p, item) => obj(p, item, (ref) => {
    oneOf(`${p}.kind`, ref.kind, PRINCIPAL_KINDS)
    if (!isText(ref.id)) bad(`${p}.id`, 'non-empty text')
  }))
  const toolClasses = (path: string, v: unknown): void =>
    list(path, v, (p, item) => { if (!isToolClass(item)) bad(p, `a tool class (${TOOL_CLASSES.join(', ')}, or mcp:<server>)`) })

  if (!isObj(policy)) return ['policy: must be an object']
  const p = policy

  oneOf('posture', p.posture, POSTURES)
  oneOf('mode', p.mode, MODES)

  obj('surfaces', p.surfaces, (surfaces) => {
    for (const [id, value] of Object.entries(surfaces)) {
      const at = `surfaces.${id}`
      if (!SURFACE_IDS.includes(id)) { bad(at, `a known surface (${SURFACE_IDS.join(', ')})`); continue }
      obj(at, value, (s) => {
        bool(`${at}.enabled`, s.enabled)
        text(`${at}.account`, s.account)
        principals(`${at}.users`, s.users)
        bool(`${at}.anyoneInAllowedRoom`, s.anyoneInAllowedRoom)
        list(`${at}.rooms`, s.rooms, (rp, rule) => obj(rp, rule, (r) => {
          const m = r.match
          const keys = isObj(m) ? Object.keys(m) : []
          const ok = isObj(m) && keys.length === 1 && (keys[0] === 'room' || keys[0] === 'category') && isText(m[keys[0]])
          if (!ok) bad(`${rp}.match`, 'exactly one of { room } or { category }, with non-empty text')
          oneOf(`${rp}.mode`, r.mode, ROOM_MODES)
        }))
        obj(`${at}.dm`, s.dm, (dm) => {
          oneOf(`${at}.dm.mode`, dm.mode, DM_MODES)
          principals(`${at}.dm.users`, dm.users)
        })
        obj(`${at}.bots`, s.bots, (bots) => {
          oneOf(`${at}.bots.mode`, bots.mode, BOT_MODES)
          bool(`${at}.bots.inlineMentionOnly`, bots.inlineMentionOnly)
          texts(`${at}.bots.roles`, bots.roles)
          if (bots.ids !== undefined) texts(`${at}.bots.ids`, bots.ids)
          if (!Number.isInteger(bots.maxAlternatingTurns) || (bots.maxAlternatingTurns as number) < 0) {
            bad(`${at}.bots.maxAlternatingTurns`, 'a whole number, 0 or more')
          }
        })
        obj(`${at}.invites`, s.invites, (inv) => oneOf(`${at}.invites.mode`, inv.mode, INVITE_MODES))
        bool(`${at}.threadsRequireMention`, s.threadsRequireMention)
        bool(`${at}.observeUnmentioned`, s.observeUnmentioned)
        principals(`${at}.admins`, s.admins)
        texts(`${at}.approverRoles`, s.approverRoles)
      })
    }
  })

  obj('tools', p.tools, (tools) => {
    toolClasses('tools.allow', tools.allow)
    toolClasses('tools.ask', tools.ask)
    toolClasses('tools.deny', tools.deny)
    if (tools.perRoom !== undefined) {
      obj('tools.perRoom', tools.perRoom, (rooms) => {
        for (const [room, value] of Object.entries(rooms)) {
          obj(`tools.perRoom.${room}`, value, (r) => {
            for (const k of ['allow', 'ask', 'deny']) if (r[k] !== undefined) toolClasses(`tools.perRoom.${room}.${k}`, r[k])
          })
        }
      })
    }
    oneOf('tools.browserGuard', tools.browserGuard, BROWSER_GUARDS)
  })

  list('keys', p.keys, (kp, grant) => obj(kp, grant, (g) => {
    if (!isText(g.ref)) bad(`${kp}.ref`, 'non-empty text')
    oneOf(`${kp}.kind`, g.kind, KEY_KINDS)
    texts(`${kp}.hosts`, g.hosts)
    if (g.rooms !== undefined) texts(`${kp}.rooms`, g.rooms)
  }))

  obj('egress', p.egress, (egress) => {
    if (egress.default !== 'deny') bad('egress.default', "'deny'")
    list('egress.hosts', egress.hosts, (hp, h) => obj(hp, h, (host) => {
      if (!isText(host.host)) bad(`${hp}.host`, 'non-empty text')
      if (host.methods !== undefined) texts(`${hp}.methods`, host.methods)
    }))
    if (egress.blockPrivateRanges !== true) bad('egress.blockPrivateRanges', 'true')
  })

  obj('memory', p.memory, (memory) => {
    bool('memory.threadsPoolIntoParent', memory.threadsPoolIntoParent)
    if (memory.dmIsolated !== true) bad('memory.dmIsolated', 'true')
    obj('memory.team', memory.team, (team) => {
      oneOf('memory.team.dm', team.dm, ['none', 'read'])
      oneOf('memory.team.group', team.group, ['none', 'read', 'read-write'])
      oneOf('memory.team.public', team.public, ['none', 'read'])
    })
    obj('memory.store', memory.store, (store) => {
      if (store.kind !== 'git-markdown') bad('memory.store.kind', "'git-markdown'")
      text('memory.store.repo', store.repo)
    })
  })

  obj('session', p.session, (session) => {
    bool('session.groupShared', session.groupShared)
    const hour = session.resetAtLocalHour
    if (hour !== undefined && !(Number.isInteger(hour) && (hour as number) >= 0 && (hour as number) <= 23)) {
      bad('session.resetAtLocalHour', 'a whole hour from 0 to 23')
    }
    text('session.timezone', session.timezone)
  })

  if (p.budget !== undefined) {
    obj('budget', p.budget, (budget) => {
      if (typeof budget.monthlyUsd !== 'number' || !Number.isFinite(budget.monthlyUsd) || budget.monthlyUsd < 0) {
        bad('budget.monthlyUsd', 'a number, 0 or more')
      }
      oneOf('budget.onExceed', budget.onExceed, ON_EXCEED)
    })
  }

  return errors
}
