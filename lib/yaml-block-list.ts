/**
 * Line-level, add-only edits to a `<topKey>: <childKey>: [list]` in an agent's
 * config.yaml. Same posture as lib/config-yaml-helpers.ts: never round-trip
 * the file through a YAML parser (comments + formatting matter), anchor the
 * top key at COLUMN 0 (real configs carry a nested `  platforms:` and similar
 * traps), and only touch direct children of that block.
 *
 * Shapes handled:
 *  - block list (`enabled:` + `- item` lines) → missing names appended at the
 *    list's own indentation
 *  - inline flow list (`enabled: []`, `enabled: [a, "b"]`) → rewritten in
 *    place as a block list with the same entries plus the missing names.
 *    Inline `[]` is why cyborg-public loaded 0 of its 4 plugins.
 *  - top key present, child absent → child inserted as the block's first child
 *  - top key absent → a fresh block appended at end of file
 * Anything else (a nested flow list, a scalar child, `topKey: {..}` inline)
 * is left byte-identical and reported as `bailed` — guessing could produce a
 * duplicate key or a mis-nested list.
 *
 * Never removes an entry. Idempotent: a second call with the same names
 * returns the input unchanged.
 */

export interface BlockListResult {
  content: string
  /** names that were not present before and now are */
  added: string[]
  /** an inline flow list was rewritten as a block list */
  converted: boolean
  /** the shape was not recognised; content is unchanged */
  bailed: boolean
}

const SAFE_NAME = /^[A-Za-z0-9._:/@-]+$/

function unquote(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parse `[a, "b"]` → ['a','b']; null when it is not a simple flat list. */
function parseFlowList(raw: string): string[] | null {
  const t = raw.replace(/\s+#.*$/, '').trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const inner = t.slice(1, -1).trim()
  if (inner === '') return []
  if (/[[\]{}]/.test(inner)) return null
  const items = inner.split(',').map(unquote).filter((s) => s !== '')
  return items.every((s) => SAFE_NAME.test(s)) ? items : null
}

/** Names inside an existing top-level `<topKey>.<childKey>` list (block or flow). */
export function readBlockList(content: string, topKey: string, childKey: string): string[] | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const topRe = new RegExp(`^${escapeRe(topKey)}:[ \\t]*(#.*)?$`)
  const top = lines.findIndex((l) => topRe.test(l))
  if (top < 0) return null
  const childRe = new RegExp(`^(\\s+)${escapeRe(childKey)}:[ \\t]*(.*)$`)
  let childIndent: string | null = null
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || /^\s*#/.test(l)) continue
    if (/^\S/.test(l)) break
    const ind = l.match(/^(\s+)/)![1]
    if (childIndent === null) childIndent = ind
    if (ind !== childIndent) continue
    const m = l.match(childRe)
    if (!m) continue
    const rest = m[2].replace(/^#.*$/, '').trim()
    if (rest) return parseFlowList(rest)
    const out: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const lj = lines[j]
      if (lj.trim() === '' || /^\s*#/.test(lj)) continue
      const item = lj.match(/^(\s*)-\s+(.+?)\s*(#.*)?$/)
      if (item && item[1].length >= childIndent.length) { out.push(unquote(item[2])); continue }
      break
    }
    return out
  }
  return null
}

export function ensureBlockList(
  input: string,
  topKey: string,
  childKey: string,
  names: string[],
  opts: { comment?: string } = {},
): BlockListResult {
  const unchanged = (bailed = false): BlockListResult => ({ content: input, added: [], converted: false, bailed })
  for (const n of names) {
    if (!SAFE_NAME.test(n)) throw new Error(`unsafe list entry "${n}" for ${topKey}.${childKey}`)
  }
  const wanted = Array.from(new Set(names))

  const crlf = input.includes('\r\n')
  const content = crlf ? input.replace(/\r\n/g, '\n') : input
  const restore = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s)
  const lines = content.split('\n')

  const topRe = new RegExp(`^${escapeRe(topKey)}:[ \\t]*(#.*)?$`)
  const top = lines.findIndex((l) => topRe.test(l))

  if (top < 0) {
    // `topKey: {...}` / `topKey: x` inline → don't add a duplicate key.
    if (lines.some((l) => new RegExp(`^${escapeRe(topKey)}:[ \\t]*[^\\s#]`).test(l))) return unchanged(true)
    if (wanted.length === 0) return unchanged()
    const block = [
      ...(opts.comment ? [`# ${opts.comment}`] : []),
      `${topKey}:`,
      `  ${childKey}:`,
      ...wanted.map((n) => `    - ${n}`),
    ]
    const base = content.replace(/\n*$/, '')
    return { content: restore(`${base}\n\n${block.join('\n')}\n`), added: wanted, converted: false, bailed: false }
  }

  // Walk the block: direct children share the first child's indentation.
  let blockEnd = lines.length
  let childIndent: string | null = null
  let childIdx = -1
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || /^\s*#/.test(l)) continue
    if (/^\S/.test(l)) { blockEnd = i; break }
    const ind = l.match(/^(\s+)/)![1]
    if (childIndent === null) childIndent = ind
    if (childIdx < 0 && ind === childIndent && new RegExp(`^\\s+${escapeRe(childKey)}:`).test(l)) childIdx = i
  }
  const ci = childIndent ?? '  '

  if (childIdx < 0) {
    if (wanted.length === 0) return unchanged()
    lines.splice(top + 1, 0, `${ci}${childKey}:`, ...wanted.map((n) => `${ci}  - ${n}`))
    return { content: restore(lines.join('\n')), added: wanted, converted: false, bailed: false }
  }

  const rest = lines[childIdx].slice(ci.length + childKey.length + 1).replace(/^[ \t]*#.*$/, '').trim()

  if (rest) {
    const existing = parseFlowList(rest)
    if (existing === null) return unchanged(true)
    const added = wanted.filter((n) => !existing.includes(n))
    const all = [...existing, ...added]
    const replacement = all.length > 0
      ? [`${ci}${childKey}:`, ...all.map((n) => `${ci}  - ${n}`)]
      : [lines[childIdx]] // empty inline list and nothing to add → leave as is
    if (all.length === 0) return unchanged()
    lines.splice(childIdx, 1, ...replacement)
    return { content: restore(lines.join('\n')), added, converted: true, bailed: false }
  }

  // Block list: collect items (YAML allows items at the key's own indent).
  const present = new Set<string>()
  let itemIndent = ''
  let lastItem = childIdx
  for (let j = childIdx + 1; j < blockEnd; j++) {
    const lj = lines[j]
    if (lj.trim() === '' || /^\s*#/.test(lj)) continue
    const item = lj.match(/^(\s*)-\s+(.+?)\s*(#.*)?$/)
    if (item && item[1].length >= ci.length) {
      present.add(unquote(item[2]))
      if (!itemIndent) itemIndent = item[1]
      lastItem = j
      continue
    }
    break
  }
  const added = wanted.filter((n) => !present.has(n))
  if (added.length === 0) return unchanged()
  const indent = itemIndent || `${ci}  `
  lines.splice(lastItem + 1, 0, ...added.map((n) => `${indent}- ${n}`))
  return { content: restore(lines.join('\n')), added, converted: false, bailed: false }
}
