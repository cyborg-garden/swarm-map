#!/usr/bin/env node
/**
 * backfill-extra-mounts — record a fleet's hand-added compose bind mounts into
 * `harnesses.json` `extraMounts`, so a compose regeneration re-renders them
 * instead of silently dropping them (#222).
 *
 * DRY RUN BY DEFAULT. It prints the exact harnesses.json change it would make
 * and exits without touching anything. `--apply` is the only thing that writes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * A mount that lives only in the generated compose file is protected by nothing
 * but `isDeployBornCompose()` — a substring test for 'google-multiplayer-mcp' /
 * '/opt/google/tokens' / 'read_only: true' — consulted at exactly ONE call site
 * (the settings PUT, and only when the VPN toggle or the resource limits
 * change). Any other path that regenerates a compose, any rename of a container
 * path, or any relaxation of that 409 drops the mount, and the container comes
 * back healthy with the capability gone. That is how the iris gate-intake
 * mounts were lost once already.
 *
 * Recording the mount in `extraMounts` is the durable fix: `generateStandalone
 * Compose` re-renders every recorded mount on every regeneration.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES *NOT* FIX — READ BEFORE RELAXING ANY GUARD
 *
 * `extraMounts` carries mounts. It does NOT carry the rest of what a
 * deploy-born or hand-maintained compose holds: `read_only`/`tmpfs` hardening,
 * `security_opt`, extra published ports (e.g. the Google OAuth callback), the
 * `environment:` block, or a non-default `env_file`. Regenerating such an agent
 * still loses those. So:
 *
 *   Backfilling extraMounts is NOT a licence to relax the isDeployBornCompose
 *   409. It shrinks the blast radius of an accidental regeneration; it does not
 *   make regeneration safe.
 *
 * ---------------------------------------------------------------------------
 * THE MODE TRAP
 *
 * Docker's short-syntax default for `- /host:/container` is **rw**.
 * `ExtraMount.mode`'s default is **ro** (deliberately — see lib/types.ts).
 * They disagree. A backfill that copies a compose mount without an explicit
 * mode therefore FLIPS IT TO READ-ONLY on the next regeneration, which for a
 * token directory like `/opt/google/tokens` means OAuth refresh starts failing
 * with a permission error nobody connects back to this script.
 *
 * This script always writes `mode` explicitly, and prints a per-mount note
 * whenever the mode came from docker's implicit default rather than the file.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *
 *   node scripts/backfill-extra-mounts.mjs                 # dry run (default)
 *   node scripts/backfill-extra-mounts.mjs --only personal # one agent
 *   node scripts/backfill-extra-mounts.mjs --json          # machine-readable
 *   node scripts/backfill-extra-mounts.mjs --apply         # WRITE (backs up first)
 *   node scripts/backfill-extra-mounts.mjs --verify        # coverage report only
 *
 *   --hsm-home <dir>   default $HSM_HOME or ~/.hermes-swarm-map
 *
 * EXIT CODES
 *   0  clean (dry run with a plan, or apply succeeded, or nothing to do)
 *   1  refused — a guard tripped; nothing was written
 *   2  usage / IO error
 *
 * ---------------------------------------------------------------------------
 * RUNBOOK
 *
 * Run this ON the host that owns ~/.hermes-swarm-map. Run it from a copy first
 * if you want to see the plan without any chance of a write:
 *
 *     mkdir -p /tmp/hsm-dry && cp -R ~/.hermes-swarm-map/compose \
 *         ~/.hermes-swarm-map/harnesses.json /tmp/hsm-dry/
 *     node scripts/backfill-extra-mounts.mjs --hsm-home /tmp/hsm-dry
 *
 * 1. PLAN
 *      node scripts/backfill-extra-mounts.mjs
 *    Read the per-agent list and the diff. Every `+` line must be a mount you
 *    recognise. Exit 1 means a guard tripped — fix that, do not force past it.
 *
 * 2. APPLY
 *      node scripts/backfill-extra-mounts.mjs --apply
 *    Writes a timestamped backup next to harnesses.json first, verifies the
 *    backup byte-for-byte, then replaces the file by atomic rename. No
 *    container is touched, nothing restarts, no compose file is rewritten.
 *
 * 3. VERIFY — by content, three ways. All three, not one.
 *
 *    a. The file still parses and gained exactly what was planned:
 *         node scripts/backfill-extra-mounts.mjs --verify   # exit 0 == full coverage
 *         diff <(node -e "console.log(require('fs').readFileSync(process.argv[1],'utf8'))" \
 *                 ~/.hermes-swarm-map/harnesses.json.bak.<stamp>) \
 *              ~/.hermes-swarm-map/harnesses.json
 *
 *    b. HSM reads the mounts back through its own projection — not just off
 *       disk. `list()` and `get()` build the harness from the DISCOVERED
 *       container and re-attach overlay extras; a field that is on disk but
 *       dropped in that projection is invisible exactly where it matters:
 *         curl -s localhost:3000/api/harnesses \
 *           | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{ \
 *               for (const h of JSON.parse(s)) \
 *                 console.log(h.name, (h.extraMounts||[]).length) })"
 *       Expect a non-zero count for every agent the plan touched. A zero here
 *       with a correct file on disk means the projection dropped the field —
 *       that is the #222 failure mode, and the backfill has NOT taken effect.
 *
 *    c. A regeneration would actually re-render them. Do NOT test this by
 *       regenerating a live agent. The unit test does it hermetically:
 *         npx vitest run scripts/__tests__/backfill-extra-mounts.test.ts
 *       It feeds the planner's own output to generateStandaloneCompose and
 *       asserts each mount appears — and asserts that WITHOUT the backfill the
 *       same regeneration drops them.
 *
 *    Do NOT verify by "the agents are still up". Nothing here restarts
 *    anything, so they will be up whether this worked or not.
 *
 * 4. ROLLBACK
 *      cp ~/.hermes-swarm-map/harnesses.json.bak.<stamp> \
 *         ~/.hermes-swarm-map/harnesses.json
 *    That is the whole rollback. This script only ever adds `extraMounts`
 *    entries to existing overlays — it creates no overlay, deletes nothing,
 *    edits no compose file, and touches no container — so restoring the backup
 *    returns the system exactly to its prior state. Nothing needs restarting
 *    after a rollback either. Confirm with:
 *      node scripts/backfill-extra-mounts.mjs --verify   # exit 1, N unrecorded
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Container paths the compose GENERATOR emits on its own. A mount onto one of
 * these must never be copied into extraMounts: the generator would then render
 * it twice, and docker refuses a duplicate target — the regeneration this
 * script exists to make safe would instead fail outright. Duplicating /opt/data
 * is the likely mistake, since the state-init sidecar mounts it too.
 */
const GENERATED_TARGETS = new Set(['/opt/data', '/state'])

/** Services that are generator-owned scaffolding, not the agent itself. */
const IGNORED_SERVICE_RE = /^state-init-/

/** Mirrors checkMounts() in lib/services/harness-compose.ts. Keep in sync. */
function validateMount(m, where) {
  const problems = []
  for (const [field, value] of [['hostPath', m.hostPath], ['containerPath', m.containerPath]]) {
    if (typeof value !== 'string' || value === '') problems.push(`${where}.${field}: required`)
    else if (/[\r\n]/.test(value)) problems.push(`${where}.${field}: contains a newline`)
    else if (!value.startsWith('/')) problems.push(`${where}.${field}: must be absolute, got '${value}'`)
    else if (value.includes(':')) problems.push(`${where}.${field}: a ':' would forge the mount mode`)
  }
  if (m.mode !== 'ro' && m.mode !== 'rw') problems.push(`${where}.mode: must be 'ro' or 'rw', got '${m.mode}'`)
  if (m.note !== undefined && /[\r\n]/.test(m.note)) problems.push(`${where}.note: contains a newline`)
  return problems
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { apply: false, json: false, verify: false, only: null, hsmHome: process.env.HSM_HOME || path.join(os.homedir(), '.hermes-swarm-map') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--json') opts.json = true
    else if (a === '--verify') opts.verify = true
    else if (a === '--only') opts.only = argv[++i]
    else if (a === '--hsm-home') opts.hsmHome = argv[++i]
    else if (a === '-h' || a === '--help') opts.help = true
    else { console.error(`unknown argument: ${a}`); process.exit(2) }
  }
  return opts
}

// ---------------------------------------------------------------------------
// Compose parsing
//
// Deliberately a small hand-rolled reader rather than a YAML dependency: this
// script has to be runnable on the host with bare `node`, and it only needs the
// short-syntax `volumes:` list under each service. Anything it cannot parse
// confidently it REPORTS rather than guesses at.
// ---------------------------------------------------------------------------

/**
 * Strip a YAML end-of-line comment from a line that carries no quoted scalar.
 * In YAML a '#' only opens a comment when it follows whitespace (or starts the
 * line); `/opt/a#b` is a literal path. Used for KEY lines only — list items go
 * through readMountScalar(), which has to honour quoting.
 */
function stripYamlComment(line) {
  return line.replace(/\s+#.*$/, '').trimEnd()
}

/**
 * Read one `volumes:` list item the way YAML reads it.
 *
 * An unquoted scalar ENDS at a ' #' comment. Splitting the raw line instead
 * folds the comment into containerPath, and nothing downstream catches it:
 * validateMount() only rejects newlines, non-absolute paths and ':', while
 * GENERATED_TARGETS is an exact-match Set. So
 *
 *     - /home/u/.hermes-x:/opt/data   # agent state, do not move
 *
 * parses as containerPath '/opt/data   # agent state, do not move', stops
 * looking generator-owned, and gets copied into extraMounts — rendering a
 * DUPLICATE /opt/data target on the next regeneration, which docker refuses.
 * That is precisely the breakage this script exists to prevent, so the reader
 * has to strip the comment before splitting rather than after.
 *
 * Inside quotes a '#' is literal, so quoting is honoured first. Returns null
 * when the quoting is malformed — a REFUSAL upstream, never a silent guess.
 */
function readMountScalar(item) {
  const q = item[0]
  if (q === '#') return ''                          // `- # note` — a null item
  if (q === '"' || q === "'") {
    const end = item.indexOf(q, 1)
    if (end < 0) return null                        // unterminated quote
    const rest = stripYamlComment(item.slice(end + 1)).trim()
    if (rest !== '') return null                    // junk after the closing quote
    return item.slice(1, end)
  }
  return stripYamlComment(item).trim()
}

function parseComposeVolumes(text) {
  const lines = text.split('\n')
  // serviceName -> { specs: string[], anomalies: string[] }
  // `anomalies` is anything inside a volumes: block this reader will not claim
  // to understand — long syntax, a stray key, an unrecognised item. They are
  // REFUSALS, never skips: a mount the reader quietly ignores is a mount that
  // stays unrecorded, which is the exact failure this script exists to end.
  const services = new Map()
  // File-level anomalies: things wrong with the compose file that belong to no
  // single service, so they cannot be hung off a services entry. Carried as a
  // property rather than a Map key so `[...services.keys()]` stays a clean list
  // of service names for the candidate search in buildPlan().
  services.fileAnomalies = []
  const entry = (s) => { if (!services.has(s)) services.set(s, { specs: [], anomalies: [] }); return services.get(s) }
  let section = null         // 'services' | 'volumes' | 'networks' | other
  let service = null
  let inVolumes = false
  let volIndent = -1

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()

    if (indent === 0) {
      const m = /^([A-Za-z0-9_.-]+):/.exec(line)
      section = m ? m[1] : null
      service = null
      inVolumes = false
      continue
    }
    if (section !== 'services') continue

    if (indent === 2) {
      const m = /^([A-Za-z0-9_.-]+):\s*$/.exec(stripYamlComment(line))
      // An unmatched key at service depth must CLEAR the current service, not
      // inherit it: leaving `service` pointing at the previous one attributes
      // this service's volumes to that agent, and recording another container's
      // mounts is the one mistake this script must never make.
      //
      // Clearing alone is NOT enough, and saying otherwise would be the same
      // class of silence this script exists to end. With `service` null, every
      // volume under that key is dropped by the `if (!service) continue` below
      // — and if the AGENT's own service key parsed fine, buildPlan() resolves
      // it happily and never learns a whole service went unread. The operator
      // gets "nothing to back up" and exit 0 for a file that plainly had
      // mounts in it. So record it as a file-level anomaly, which buildPlan()
      // turns into a refusal.
      service = m ? m[1] : null
      inVolumes = false
      if (m) entry(service)
      else services.fileAnomalies.push(`unreadable service key at service depth: '${line}'`)
      continue
    }
    if (!service) continue

    if (indent === 4 && stripYamlComment(line) === 'volumes:') { inVolumes = true; volIndent = indent; continue }
    if (!inVolumes) continue
    if (indent <= volIndent) { inVolumes = false; continue }

    if (line.startsWith('- ')) {
      const item = readMountScalar(line.slice(2).trim())
      if (item === null || item === '') {
        entry(service).anomalies.push(`mount item this reader cannot quote-parse: '${line}'`)
        continue
      }
      // Long syntax opens with a mapping key (`- type: bind`).
      if (/^[A-Za-z_][A-Za-z0-9_]*:\s/.test(item)) entry(service).anomalies.push(`long-syntax mount starting '${item}'`)
      else entry(service).specs.push(item)
    } else {
      // A non-list line deeper than `volumes:` is a long-syntax continuation
      // (`source:`, `target:`, `read_only:`) or something else entirely.
      entry(service).anomalies.push(`unrecognised line inside volumes: '${line}'`)
    }
  }
  return services
}

/** A docker named volume, per compose's own naming rules. */
const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/**
 * Split a docker short-syntax mount, or return null when this reader will not
 * vouch for the result. Null is a REFUSAL upstream, not a skip.
 */
function splitMountSpec(spec) {
  const parts = spec.split(':')
  let m = null
  if (parts.length === 2) m = { hostPath: parts[0], containerPath: parts[1], mode: 'rw', modeImplicit: true }
  else if (parts.length === 3) m = { hostPath: parts[0], containerPath: parts[1], mode: parts[2], modeImplicit: false }
  if (!m) return null
  // The source must be recognisably a host path or a named volume, and the
  // target must be an absolute container path. Anything else is not a mount
  // this script understands well enough to copy.
  if (!m.hostPath.startsWith('/') && !VOLUME_NAME_RE.test(m.hostPath)) return null
  if (!m.containerPath.startsWith('/')) return null
  if (m.mode !== 'ro' && m.mode !== 'rw') return null
  return m
}

function classify(m) {
  if (!m.hostPath.startsWith('/')) return 'named-volume'   // docker named volume
  if (GENERATED_TARGETS.has(m.containerPath)) return 'generated'
  return 'extra'
}

// ---------------------------------------------------------------------------
// Harness overlay
// ---------------------------------------------------------------------------

/** Mirrors harness.ts: id = 'h_' + containerName.replace(/^hermes-/,'').replace(/-/g,'_') */
function harnessIdForAgent(agentName) {
  return 'h_' + agentName.replace(/-/g, '_')
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function buildPlan(opts) {
  const hsm = opts.hsmHome
  const harnessesPath = path.join(hsm, 'harnesses.json')
  const composeDir = path.join(hsm, 'compose')

  if (!fs.existsSync(harnessesPath)) fail(`no harnesses.json at ${harnessesPath}`)
  if (!fs.existsSync(composeDir)) fail(`no compose dir at ${composeDir}`)

  const rawHarnesses = fs.readFileSync(harnessesPath, 'utf-8')
  let overlays
  try { overlays = JSON.parse(rawHarnesses) } catch (e) { fail(`harnesses.json is not valid JSON: ${e.message}`) }
  if (!Array.isArray(overlays)) fail('harnesses.json must be a JSON array of harness overlays')

  const byId = new Map(overlays.map((o) => [o.id, o]))

  const agents = fs.readdirSync(composeDir)
    .filter((d) => fs.existsSync(path.join(composeDir, d, 'docker-compose.yml')))
    .sort()

  const plan = { harnessesPath, rawHarnesses, overlays, agents: [], refusals: [], warnings: [] }

  for (const agent of agents) {
    if (opts.only && agent !== opts.only) continue
    const composePath = path.join(composeDir, agent, 'docker-compose.yml')
    const services = parseComposeVolumes(fs.readFileSync(composePath, 'utf-8'))

    const id = harnessIdForAgent(agent)
    const entry = byId.get(id)
    const record = { agent, id, composePath, hasOverlay: !!entry, existing: [], additions: [], skipped: [], notes: [] }

    // Which service is the agent? Prefer the overlay's recorded serviceName,
    // else `hermes-<agent>`, else the sole non-scaffolding service. Ambiguity is
    // reported, never guessed: picking the wrong service would record another
    // container's mounts onto this agent.
    // A file-level anomaly is a refusal for this agent no matter which service
    // it sat under: the reader cannot show that the unread lines held no mount,
    // and an unrecorded mount is exactly what this script exists to prevent.
    // Raised BEFORE the service search so it is reported even when the agent's
    // own service resolves cleanly.
    for (const a of services.fileAnomalies) {
      plan.refusals.push(`${agent}: ${a} in ${composePath} — this reader will not guess at it; fix the compose file by hand`)
    }

    const candidates = [...services.keys()].filter((s) => !IGNORED_SERVICE_RE.test(s))
    let svc = entry?.serviceName && services.has(entry.serviceName) ? entry.serviceName
      : services.has(`hermes-${agent}`) ? `hermes-${agent}`
      : candidates.length === 1 ? candidates[0]
      : null
    if (!svc) {
      plan.refusals.push(`${agent}: cannot identify the agent service in ${composePath} (candidates: ${candidates.join(', ') || 'none'})`)
      plan.agents.push(record)
      continue
    }
    record.service = svc

    const recorded = Array.isArray(entry?.extraMounts) ? entry.extraMounts : []
    record.existing = recorded

    // Pre-existing extraMounts must themselves be legal and non-generated. A
    // pre-broken overlay would make the "after" state unrenderable, and this
    // script must never hand back a harnesses.json that fails generation.
    recorded.forEach((m, i) => {
      const problems = validateMount({ ...m, mode: m.mode ?? 'ro' }, `${agent}.extraMounts[${i}]`)
      problems.forEach((p) => plan.refusals.push(`${agent}: existing overlay entry is invalid — ${p}`))
      if (GENERATED_TARGETS.has(m.containerPath)) {
        plan.refusals.push(`${agent}: existing extraMounts already targets the generated path ${m.containerPath} — fix by hand before backfilling`)
      }
    })

    const byTarget = new Map(recorded.map((m) => [m.containerPath, m]))
    const seenTargets = new Set()

    for (const a of services.get(svc).anomalies) {
      plan.refusals.push(`${agent}: ${a} — this reader will not guess at it; record that mount by hand`)
    }

    for (const spec of services.get(svc).specs) {
      const m = splitMountSpec(spec)
      if (!m) {
        plan.refusals.push(`${agent}: cannot parse mount '${spec}' — resolve by hand`)
        continue
      }
      const kind = classify(m)
      if (kind !== 'extra') { record.skipped.push({ ...m, kind }); continue }

      // Guard: never duplicate a generator-owned target.
      if (GENERATED_TARGETS.has(m.containerPath)) {
        plan.refusals.push(`${agent}: refusing to record ${m.containerPath} — the generator emits it, recording it would render a duplicate target`)
        continue
      }
      // Guard: two compose mounts onto one container path.
      if (seenTargets.has(m.containerPath)) {
        plan.refusals.push(`${agent}: compose mounts ${m.containerPath} more than once — resolve by hand`)
        continue
      }
      seenTargets.add(m.containerPath)

      const already = byTarget.get(m.containerPath)
      if (already) {
        // Idempotence: identical → nothing to do. Divergent → refuse, because
        // silently "fixing" either direction changes what the container gets.
        const sameHost = already.hostPath === m.hostPath
        const sameMode = (already.mode ?? 'ro') === m.mode
        if (sameHost && sameMode) { record.skipped.push({ ...m, kind: 'already-recorded' }); continue }
        plan.refusals.push(
          `${agent}: ${m.containerPath} is recorded as ${already.hostPath}:${already.mode ?? 'ro'} ` +
          `but the compose has ${m.hostPath}:${m.mode} — resolve by hand`)
        continue
      }

      const addition = {
        hostPath: m.hostPath,
        containerPath: m.containerPath,
        mode: m.mode,                       // ALWAYS explicit — see "THE MODE TRAP"
        note: `backfilled from ${path.relative(hsm, composePath)} on ${new Date().toISOString().slice(0, 10)}`,
        _modeImplicit: m.modeImplicit,
      }
      const problems = validateMount(addition, `${agent}.new`)
      if (problems.length) { problems.forEach((p) => plan.refusals.push(`${agent}: ${p}`)); continue }

      if (m.modeImplicit) {
        record.notes.push(`${m.containerPath}: compose omits the mode, so docker gives it rw. Recording mode:'rw' explicitly — ExtraMount would otherwise default to 'ro' and break writes.`)
      }
      if (!fs.existsSync(m.hostPath)) {
        plan.warnings.push(`${agent}: host path ${m.hostPath} does not exist — docker would create it as root on next up. Recording it anyway; verify the path is right.`)
      }
      record.additions.push(addition)
    }

    if (!entry && record.additions.length) {
      plan.warnings.push(
        `${agent}: has ${record.additions.length} unbacked mount(s) but NO entry in harnesses.json ` +
        `(id ${id}). This script never invents overlay entries — an id that does not match a discovered ` +
        `agent is inert, and a wrong one attaches another agent's mounts. Add the entry by hand, then re-run.`)
      record.additions = []
      record.blockedNoOverlay = true
    }

    plan.agents.push(record)
  }

  return plan
}

function applyPlan(plan) {
  const next = plan.overlays.map((o) => {
    const rec = plan.agents.find((a) => a.id === o.id)
    if (!rec || !rec.additions.length) return o
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const additions = rec.additions.map(({ _modeImplicit, ...m }) => m)
    return { ...o, extraMounts: [...(o.extraMounts ?? []), ...additions] }
  })
  return JSON.stringify(next, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function fail(msg) { console.error(`REFUSED: ${msg}`); process.exit(2) }

function report(plan, opts) {
  const totalAdd = plan.agents.reduce((n, a) => n + a.additions.length, 0)
  const bar = '='.repeat(74)

  console.log(bar)
  console.log(`harnesses.json : ${plan.harnessesPath}`)
  console.log(`mode           : ${opts.apply ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`)
  console.log(bar)

  for (const a of plan.agents) {
    const flag = a.blockedNoOverlay ? '  [NO OVERLAY ENTRY — SKIPPED]' : ''
    console.log(`\n${a.agent}  (${a.id}, service ${a.service ?? '?'})${flag}`)
    console.log(`  recorded already : ${a.existing.length}`)
    for (const m of a.existing) console.log(`      = ${m.hostPath} -> ${m.containerPath} (${m.mode ?? 'ro'})`)
    console.log(`  would add        : ${a.additions.length}`)
    for (const m of a.additions) console.log(`      + ${m.hostPath} -> ${m.containerPath} (${m.mode})${m._modeImplicit ? '   <- mode from docker default, made explicit' : ''}`)
    // Printed, not silent: "which mounts did it decide NOT to record, and why"
    // is the question a reviewer has to be able to answer from this output.
    const excluded = a.skipped.filter((m) => m.kind === 'generated' || m.kind === 'named-volume')
    if (excluded.length) {
      console.log(`  excluded (generator-owned — recording these would render a duplicate target):`)
      for (const m of excluded) console.log(`      · ${m.hostPath} -> ${m.containerPath}   [${m.kind}]`)
    }
    for (const n of a.notes) console.log(`    note: ${n}`)
  }

  if (plan.warnings.length) {
    console.log(`\n${bar}\nWARNINGS`)
    for (const w of plan.warnings) console.log(`  ! ${w}`)
  }
  if (plan.refusals.length) {
    console.log(`\n${bar}\nREFUSALS — nothing will be written`)
    for (const r of plan.refusals) console.log(`  x ${r}`)
  }

  console.log(`\n${bar}`)
  console.log(`total additions: ${totalAdd} across ${plan.agents.filter((a) => a.additions.length).length} agent(s)`)
  return totalAdd
}

/**
 * Line diff via LCS.
 *
 * Not a naive two-pointer walk with `indexOf` resync: harnesses.json is full of
 * repeated lines (`      {`, `    ],`, `"mode": "ro",`) and a resync on the
 * first match lands on the wrong one, producing a diff that reads plausibly and
 * attributes changes to the wrong agent. A diff nobody can trust is worse than
 * no diff, because this is the artifact a human approves `--apply` from.
 */
function printDiff(before, after) {
  const b = before.split('\n'), a = after.split('\n')
  const n = b.length, m = a.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = b[i] === a[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  console.log('\n--- harnesses.json (current)\n+++ harnesses.json (proposed)')
  let i = 0, j = 0, ctx = 0
  while (i < n && j < m) {
    if (b[i] === a[j]) {
      // A little context, then elide: the interesting part is the additions.
      if (ctx < 2) console.log(`  ${b[i]}`)
      else if (ctx === 2) console.log('  ...')
      ctx++
      i++; j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) { console.log(`- ${b[i++]}`); ctx = 0 }
    else { console.log(`+ ${a[j++]}`); ctx = 0 }
  }
  while (i < n) console.log(`- ${b[i++]}`)
  while (j < m) console.log(`+ ${a[j++]}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0]); return }

  const plan = buildPlan(opts)

  if (opts.json) {
    console.log(JSON.stringify({
      harnessesPath: plan.harnessesPath,
      refusals: plan.refusals,
      warnings: plan.warnings,
      agents: plan.agents.map((a) => ({
        ...a,
        additions: a.additions.map(({ _modeImplicit, ...m }) => ({ ...m, modeFromDockerDefault: !!_modeImplicit })),
      })),
    }, null, 2))
    process.exit(plan.refusals.length ? 1 : 0)
  }

  const totalAdd = report(plan, opts)

  if (plan.refusals.length) {
    console.log('\nRefusing to write. Resolve the items above and re-run.')
    process.exit(1)
  }
  if (totalAdd === 0) {
    console.log('\nNothing to do — every hand-added mount is already recorded. (Idempotent: safe to re-run.)')
    return
  }

  if (opts.verify) {
    console.log(`\n--verify: ${totalAdd} mount(s) are still unrecorded. Coverage is incomplete.`)
    process.exit(1)
  }

  const after = applyPlan(plan)
  printDiff(plan.rawHarnesses, after)

  if (!opts.apply) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to write.')
    return
  }

  // Backup FIRST, and prove the backup is good before touching the original.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${plan.harnessesPath}.bak.${stamp}`
  fs.writeFileSync(backup, plan.rawHarnesses, { mode: 0o600 })
  const readBack = fs.readFileSync(backup, 'utf-8')
  if (readBack !== plan.rawHarnesses) fail(`backup at ${backup} does not match the original — aborting before any write`)
  JSON.parse(readBack) // must still parse
  console.log(`\nbackup: ${backup}`)

  // The proposed content must itself be valid and complete before it lands.
  const parsed = JSON.parse(after)
  if (parsed.length !== plan.overlays.length) fail('proposed harnesses.json changed the number of overlays — aborting')

  const tmp = `${plan.harnessesPath}.tmp.${process.pid}`
  const mode = fs.statSync(plan.harnessesPath).mode & 0o777
  fs.writeFileSync(tmp, after, { mode })
  fs.renameSync(tmp, plan.harnessesPath)
  console.log(`wrote: ${plan.harnessesPath}  (${totalAdd} mount(s) recorded)`)
  console.log(`\nRollback:  cp ${backup} ${plan.harnessesPath}`)
  console.log('No container was touched. The mounts take effect only on the next compose regeneration,')
  console.log('which is still gated by the isDeployBornCompose 409 — see the header of this file.')
}

// Only when run as a CLI — so the test suite can import the planner without
// the module executing a run as a side effect of being imported.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main()
}

export { buildPlan, applyPlan, parseComposeVolumes, readMountScalar, splitMountSpec, classify, harnessIdForAgent, validateMount, GENERATED_TARGETS }
