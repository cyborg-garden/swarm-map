// JSON lines: one record per line, split on the byte 0x0A and nothing else.
// Splitting on text (readline, String.split with a regex) also breaks on
// U+2028 and U+2029, which are legal inside a JSON string and corrupt the
// record. Working on bytes also keeps a multi-byte character whole when a
// chunk boundary lands inside it.

export function encodeLine(record: unknown): string {
  return JSON.stringify(record) + '\n'
}

export interface LineDecoder { push(chunk: Buffer | string): void }

export function createLineDecoder(
  onRecord: (record: unknown) => void,
  onError: (err: Error) => void = () => {},
  opts: { maxLineBytes?: number } = {},
): LineDecoder {
  const max = opts.maxLineBytes ?? 8 * 1024 * 1024
  let pending: Buffer[] = []
  let pendingBytes = 0
  let overflowed = false

  const finish = (): void => {
    const line = Buffer.concat(pending).toString('utf8').trim()
    pending = []
    pendingBytes = 0
    if (overflowed) { overflowed = false; return }
    if (line === '') return
    try {
      onRecord(JSON.parse(line))
    } catch {
      onError(new Error('line is not JSON'))
    }
  }

  const keep = (part: Buffer): void => {
    if (overflowed) return
    if (pendingBytes + part.length > max) {
      overflowed = true
      pending = []
      pendingBytes = 0
      onError(new Error(`line longer than ${max} bytes`))
      return
    }
    pending.push(part)
    pendingBytes += part.length
  }

  return {
    push(chunk) {
      let rest = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      for (let nl = rest.indexOf(0x0a); nl !== -1; nl = rest.indexOf(0x0a)) {
        keep(rest.subarray(0, nl))
        finish()
        rest = rest.subarray(nl + 1)
      }
      if (rest.length > 0) keep(rest)
    },
  }
}
