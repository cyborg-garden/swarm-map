// BROKEN ON PURPOSE. The door's notes for each room (lib/door/memory.ts), kept wrong in one named way,
// so the memory checks (suites/memory-checks.ts) can be shown to go red. Nothing outside the
// conformance suite imports this file.
//
//   memory-one-room    every room is kept under one key: one room's notes reach another
//   memory-no-checks   the store writes whatever it is asked to: a secret is kept (built with checks off)
//   memory-cached      the store reads each room once and keeps it: a wipe on disk is not seen
//   memory-in-scratch  the notes' folder is inside the scratch folder, where a file tool can write (set up by the lab)
import type { MemoryStore } from '../../lib/door/memory.ts'

export type BrokenMemory = 'memory-one-room' | 'memory-no-checks' | 'memory-cached' | 'memory-in-scratch'

export function brokenMemoryStore(rig: string | undefined, store: MemoryStore): MemoryStore {
  if (rig === 'memory-one-room') {
    const one = 'one-room'
    return { ...store, render: () => store.render(one), apply: (_room, input, ctx) => store.apply(one, input, ctx) }
  }
  if (rig === 'memory-cached') {
    const seen = new Map<string, string | undefined>()
    return {
      ...store,
      render: (room) => { if (!seen.has(room)) seen.set(room, store.render(room)); return seen.get(room) },
      apply: (room, input, ctx) => { const r = store.apply(room, input, ctx); seen.set(room, store.render(room)); return r },
    }
  }
  return store
}
