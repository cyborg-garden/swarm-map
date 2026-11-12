// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createLineDecoder, encodeLine } from '../framing.ts'

function decodeAll(chunks: (Buffer | string)[]): { records: unknown[]; errors: string[] } {
  const records: unknown[] = []
  const errors: string[] = []
  const decoder = createLineDecoder((r) => records.push(r), (e) => errors.push(e.message))
  for (const chunk of chunks) decoder.push(chunk)
  return { records, errors }
}

describe('JSON-lines framing', () => {
  it('encodes one record per line, with no raw newline inside it', () => {
    const line = encodeLine({ t: 'reply', text: 'a\nb' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(decodeAll([line]).records).toEqual([{ t: 'reply', text: 'a\nb' }])
  })

  it('does not split a record on U+2028 or U+2029', () => {
    // readline-style splitters break here and corrupt the record.
    const text = 'before middle after'
    const { records, errors } = decodeAll([JSON.stringify({ text }) + '\n'])
    expect(errors).toEqual([])
    expect(records).toEqual([{ text }])
  })

  it('reassembles a record split across chunks, even inside a multi-byte character', () => {
    const bytes = Buffer.from(JSON.stringify({ text: 'café \u{1F600}' }) + '\n', 'utf8')
    for (let cut = 1; cut < bytes.length; cut++) {
      const { records, errors } = decodeAll([bytes.subarray(0, cut), bytes.subarray(cut)])
      expect(errors, `cut at ${cut}`).toEqual([])
      expect(records).toEqual([{ text: 'café \u{1F600}' }])
    }
  })

  it('yields several records from one chunk and ignores blank lines', () => {
    expect(decodeAll(['{"a":1}\n\n{"a":2}\r\n{"a":3}\n']).records).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it('reports a line that is not JSON and keeps going', () => {
    const { records, errors } = decodeAll(['not json\n{"ok":true}\n'])
    expect(errors).toHaveLength(1)
    expect(records).toEqual([{ ok: true }])
  })

  it('refuses a line longer than the limit instead of buffering forever', () => {
    const records: unknown[] = []
    const errors: string[] = []
    const decoder = createLineDecoder((r) => records.push(r), (e) => errors.push(e.message), { maxLineBytes: 64 })
    decoder.push('x'.repeat(200))
    decoder.push('\n{"ok":true}\n')
    expect(errors).toEqual(['line longer than 64 bytes'])
    expect(records).toEqual([{ ok: true }])
  })
})
