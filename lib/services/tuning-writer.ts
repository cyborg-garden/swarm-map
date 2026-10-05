import fs from 'fs'
import path from 'path'
import { services } from '@/lib/services'
import { guessDataDir, yamlScalar } from '@/lib/services/harness'
import { sectionBodyEnd } from '@/lib/services/cascade-writer'

/**
 * Tuning writer — the guarded path for the few numeric runtime knobs HSM
 * exposes per agent: how much persistent memory the agent keeps, how many
 * tool turns it may take, and when context compression kicks in.
 *
 * Each knob is ONE scalar key inside ONE top-level section of config.yaml
 * (`memory.memory_char_limit`, `agent.max_turns`, …). Only column-0 section
 * headers count: config.yaml also carries a nested `platforms:` block and a
 * `goals:` section with its own `max_turns:`, and a substring patch hits
 * those. The file is spliced by LINE, never via a YAML library:
 *  - an existing key has only its value rewritten (indent and a trailing
 *    `# comment` kept); an unchanged value leaves its line untouched, so a
 *    no-op save is byte-identical;
 *  - a missing key is inserted at the end of its section's body at the
 *    section's own indent; a missing section is appended after one blank line;
 *  - a duplicate top-level header, or a flow-form one (`memory: {…}`), is
 *    refused — nobody can say which copy the runtime reads.
 *
 * Values are validated against TUNING_SPEC before anything is read from disk.
 * Hermes reads these at agent start, so a write takes effect on restart.
 */

export type TuningKey = 'memoryCharLimit' | 'userCharLimit' | 'maxTurns' | 'compressionThreshold' | 'protectLastN'

export type TuningSpec = {
  id: TuningKey
  section: string
  key: string
  integer: boolean
  min: number
  max: number
  /** What hermes-agent uses when the key is absent (hermes_cli/config.py). */
  runtimeDefault: number
}

export const TUNING_SPEC: TuningSpec[] = [
  // ~2.75 chars/token: 2200 chars ≈ 800 tokens of always-loaded memory.
  { id: 'memoryCharLimit', section: 'memory', key: 'memory_char_limit', integer: true, min: 500, max: 20000, runtimeDefault: 2200 },
  { id: 'userCharLimit', section: 'memory', key: 'user_char_limit', integer: true, min: 200, max: 10000, runtimeDefault: 1375 },
  { id: 'maxTurns', section: 'agent', key: 'max_turns', integer: true, min: 1, max: 500, runtimeDefault: 90 },
  { id: 'compressionThreshold', section: 'compression', key: 'threshold', integer: false, min: 0.1, max: 0.95, runtimeDefault: 0.5 },
  { id: 'protectLastN', section: 'compression', key: 'protect_last_n', integer: true, min: 1, max: 200, runtimeDefault: 20 },
]

export type TuningValues = Record<TuningKey, number | null>
/** A number sets the key; null removes it (the runtime default applies). */
export type TuningEdits = Partial<Record<TuningKey, number | null>>

type Fail = { ok: false; status: 400 | 404 | 409; error: string }

const isBlank = (line: string): boolean => line.trim() === ''
const indentOf = (line: string): string => line.slice(0, line.length - line.trimStart().length)
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const headerRe = (section: string) => new RegExp(`^${esc(section)}:(\\s|$)`)

function splitLines(text: string): { lines: string[]; eol: string } {
  const firstNl = text.indexOf('\n')
  const eol = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n'
  const lines = text.split('\n').map((l) => (eol === '\r\n' && l.endsWith('\r') ? l.slice(0, -1) : l))
  return { lines, eol }
}

type Section = { header: number; end: number; indent: string | null }

/** Locate a top-level section. null = absent; a Fail = present but not safely editable. */
function findSection(lines: string[], section: string): Section | null | Fail {
  const re = headerRe(section)
  const headers = lines.flatMap((l, i) => (re.test(l) ? [i] : []))
  // A quoted spelling of the same key is the same section to a YAML parser;
  // adding an unquoted one beside it would shadow it (last key wins).
  const quoted = new RegExp(`^["']${esc(section)}["']\\s*:`)
  const q = lines.findIndex((l) => quoted.test(l))
  if (q >= 0) {
    return { ok: false, status: 409, error: `duplicate-sections: config.yaml spells ${section}: quoted on line ${q + 1}; unquote it by hand before saving` }
  }
  if (headers.length === 0) return null
  if (headers.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `duplicate-sections: config.yaml has ${headers.length}× top-level ${section}: (lines ${headers.map((i) => i + 1).join(', ')}); remove the duplicate by hand before saving`,
    }
  }
  const header = headers[0]
  if (yamlScalar(lines[header].slice(section.length + 1)) !== '') {
    return { ok: false, status: 409, error: `inline-section: ${section}: is written inline on line ${header + 1}; edit it by hand` }
  }
  const end = sectionBodyEnd(lines, header)
  let indent: string | null = null
  for (let i = header + 1; i < end; i++) {
    const l = lines[i]
    if (isBlank(l) || l.trimStart().startsWith('#')) continue
    indent = indentOf(l)
    break
  }
  return { header, end, indent }
}

/** Every line index of `key:` directly inside the section (at the section's own indent). */
function findKeys(lines: string[], sec: Section, key: string): number[] {
  if (sec.indent === null || sec.indent === '') return []
  const re = new RegExp(`^${esc(sec.indent)}${esc(key)}:(\\s|$)`)
  const out: number[] = []
  for (let i = sec.header + 1; i < sec.end; i++) if (re.test(lines[i])) out.push(i)
  return out
}

/**
 * Refuse a section whose shape this line editor cannot edit safely: every
 * line at the section's indent must be a `key: value` / `key:` mapping line,
 * the target key must appear at most once (YAML keeps the LAST copy, so
 * editing the first is a silent no-op), and its value must sit on its own
 * line (a value continued on deeper lines would be glued onto the new one).
 */
function checkSection(lines: string[], sec: Section, section: string, key: string): Fail | null {
  const refuse = (i: number, why: string): Fail => ({
    ok: false,
    status: 409,
    error: `unsupported-shape: ${section}: line ${i + 1} ${why}; edit it by hand`,
  })
  if (sec.indent === null) return null
  if (sec.indent === '') return refuse(sec.header + 1, 'is a list, not a mapping')
  for (let i = sec.header + 1; i < sec.end; i++) {
    const l = lines[i]
    if (isBlank(l) || l.trimStart().startsWith('#')) continue
    if (indentOf(l).length > sec.indent.length) continue
    if (indentOf(l) !== sec.indent || !/^[^\s#-][^:]*:(\s|$)/.test(l.trimStart())) {
      return refuse(i, 'is not a `key: value` line')
    }
  }
  const at = findKeys(lines, sec, key)
  if (at.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `duplicate-keys: ${section}.${key} appears ${at.length}× (lines ${at.map((i) => i + 1).join(', ')}); remove the duplicate by hand before saving`,
    }
  }
  if (at.length === 1) {
    const next = lines.slice(at[0] + 1, sec.end).find((l) => !isBlank(l) && !l.trimStart().startsWith('#'))
    if (next !== undefined && indentOf(next).length > sec.indent.length) {
      return refuse(at[0], `has a value spread over several lines`)
    }
  }
  return null
}

const formatValue = (s: TuningSpec, v: number): string => (s.integer ? String(v) : String(Math.round(v * 1e4) / 1e4))

function parseNumber(line: string, key: string): number | null {
  const raw = yamlScalar(line.trimStart().slice(key.length + 1))
  if (raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function readTuning(text: string): TuningValues {
  const { lines } = splitLines(text)
  const out = {} as TuningValues
  for (const s of TUNING_SPEC) {
    const sec = findSection(lines, s.section)
    // The LAST copy of a duplicated key is the one a YAML parser keeps.
    const at = sec && !('ok' in sec) ? findKeys(lines, sec, s.key).at(-1) ?? -1 : -1
    out[s.id] = at >= 0 ? parseNumber(lines[at], s.key) : null
  }
  return out
}

export function validateTuning(edits: TuningEdits): Fail | null {
  if (!edits || typeof edits !== 'object') return { ok: false, status: 400, error: 'Body must be an object of tuning values' }
  for (const [id, v] of Object.entries(edits)) {
    const s = TUNING_SPEC.find((x) => x.id === id)
    if (!s) return { ok: false, status: 400, error: `Unknown tuning key: ${id}` }
    if (v === null) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, status: 400, error: `${id} must be a number` }
    if (s.integer && !Number.isInteger(v)) return { ok: false, status: 400, error: `${id} must be a whole number` }
    if (v < s.min || v > s.max) return { ok: false, status: 400, error: `${id} must be between ${s.min} and ${s.max}` }
  }
  return null
}

export function spliceTuning(text: string, edits: TuningEdits): { ok: true; text: string } | Fail {
  const bad = validateTuning(edits)
  if (bad) return bad
  if (text.startsWith('\uFEFF')) {
    return { ok: false, status: 409, error: 'unsupported-shape: config.yaml starts with a byte-order mark; edit it by hand' }
  }
  const { lines, eol } = splitLines(text)
  const hadTrailingNewline = text.endsWith('\n')

  for (const s of TUNING_SPEC) {
    const v = edits[s.id]
    if (v === undefined) continue
    const sec = findSection(lines, s.section)
    if (sec && 'ok' in sec) return sec
    if (sec) {
      const shape = checkSection(lines, sec, s.section, s.key)
      if (shape) return shape
    }
    const at = sec ? findKeys(lines, sec, s.key)[0] ?? -1 : -1
    if (v === null) {
      if (at >= 0) lines.splice(at, 1)
      continue
    }
    const value = formatValue(s, v)
    if (!sec) {
      while (lines.length && isBlank(lines[lines.length - 1])) lines.pop()
      if (lines.length) lines.push('')
      lines.push(`${s.section}:`, `  ${s.key}: ${value}`, '')
      continue
    }
    if (at >= 0) {
      if (parseNumber(lines[at], s.key) === Number(value)) continue
      const indent = indentOf(lines[at])
      const rest = lines[at].slice(indent.length + s.key.length + 1)
      const comment = rest.match(/(\s+#.*)$/)?.[1] ?? ''
      lines[at] = `${indent}${s.key}: ${value}${comment}`
    } else {
      lines.splice(sec.end, 0, `${sec.indent || '  '}${s.key}: ${value}`)
    }
  }

  // splitLines leaves one '' after a trailing newline; the appended-section
  // path adds the same, so join reproduces "ends in exactly one newline".
  let out = lines.join(eol)
  if (!hadTrailingNewline && out.endsWith(eol) && text !== '') out = out.slice(0, -eol.length)
  return { ok: true, text: out }
}

export type TuningWriteResult = ({ ok: true; unchanged: boolean; values: TuningValues }) | Fail

export function tuningDataDir(harness: { name: string; serviceName?: string }): string {
  const containerName = harness.serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  return guessDataDir(harness.serviceName ?? harness.name, containerName)
}

export function readHarnessTuning(harnessId: string): { ok: true; values: TuningValues } | Fail {
  const harness = services.harness.get(harnessId)
  if (!harness) return { ok: false, status: 404, error: 'Harness not found' }
  try {
    return { ok: true, values: readTuning(fs.readFileSync(path.join(tuningDataDir(harness), 'config.yaml'), 'utf-8')) }
  } catch {
    return { ok: false, status: 404, error: 'config.yaml not found for this harness' }
  }
}

export function applyTuningToHarness(
  harnessId: string,
  edits: TuningEdits,
  opts: { who: string; expected?: Partial<TuningValues> }
): TuningWriteResult {
  const bad = validateTuning(edits)
  if (bad) return bad
  const harness = services.harness.get(harnessId)
  if (!harness) return { ok: false, status: 404, error: 'Harness not found' }
  const configPath = path.join(tuningDataDir(harness), 'config.yaml')

  // Never create config.yaml: an agent without one is not one this writer
  // understands, and a half-file would crash-loop it.
  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return { ok: false, status: 404, error: 'config.yaml not found for this harness' }
  }

  const before = readTuning(content)
  if (opts.expected) {
    for (const [id, want] of Object.entries(opts.expected)) {
      if (before[id as TuningKey] !== (want ?? null)) {
        return { ok: false, status: 409, error: `config.yaml changed since you loaded it (${id} is now ${before[id as TuningKey] ?? 'unset'}) — reload and re-apply` }
      }
    }
  }

  const r = spliceTuning(content, edits)
  if (!r.ok) return r
  if (r.text === content) return { ok: true, unchanged: true, values: before }

  fs.writeFileSync(configPath, r.text, 'utf-8')
  const after = readTuning(r.text)
  const changes = Object.fromEntries(
    TUNING_SPEC.filter((s) => before[s.id] !== after[s.id]).map((s) => [`${s.section}.${s.key}`, { from: before[s.id], to: after[s.id] }])
  )
  services.audit.append({ who: opts.who, what: 'harness.tuning.update', target: harnessId, meta: changes })
  return { ok: true, unchanged: false, values: after }
}
