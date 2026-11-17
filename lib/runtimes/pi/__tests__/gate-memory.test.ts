// @vitest-environment node
//
// The door's own tool, `memory_note`, as the gate gives it to Pi: declared with a schema, run by
// asking the door through an `input` dialog, and given the door's words back. It does nothing in
// the cell, so the gate's tool_call check lets it through without asking (the door decides when it runs).
import { describe, expect, it } from 'vitest'
import swarmGate, { MEMORY_TOOL, MEMORY_TOOL_DEFINITION, type PiToolDefinition } from '../cell/gate.ts'
import { MEMORY_TOOL as DOOR_MEMORY_TOOL } from '../../../door/memory.ts'
import { PI_TOOL_MAP } from '../caps.ts'
import { DOOR_PREFIX } from '../rpc.ts'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>
function load() {
  const handlers: Record<string, Handler> = {}
  const tools: Record<string, PiToolDefinition> = {}
  ;(swarmGate as (pi: unknown) => void)({
    on: (name: string, handler: Handler) => { handlers[name] = handler },
    registerTool: (tool: PiToolDefinition) => { tools[tool.name] = tool },
  })
  return { handlers, tools }
}

describe('the door\'s memory tool in Pi', () => {
  it('[U:pi-memory] the gate registers it under the name the door and the tool map use, class memory', () => {
    const { tools } = load()
    expect(Object.keys(tools)).toEqual([MEMORY_TOOL])
    expect(MEMORY_TOOL).toBe(DOOR_MEMORY_TOOL)
    expect(PI_TOOL_MAP[MEMORY_TOOL]).toBe('memory')
    expect(tools[MEMORY_TOOL].parameters).toEqual(MEMORY_TOOL_DEFINITION.parameters)
    expect(MEMORY_TOOL_DEFINITION.parameters).toMatchObject({ required: ['file', 'op'], additionalProperties: false })
  })

  it('[U:pi-memory] running it asks the door with an input dialog and hands back the door\'s answer, word for word', async () => {
    const { tools } = load()
    const asked: string[] = []
    const ctx = { hasUI: true, ui: { input: async (title: string) => { asked.push(title); return 'Saved. The door keeps it for this room.' } } }
    const out = await tools[MEMORY_TOOL].execute('call-9', { file: 'room', op: 'add', text: 'ferns' }, undefined, undefined, ctx)
    expect(out.content).toEqual([{ type: 'text', text: 'Saved. The door keeps it for this room.' }])
    expect(asked).toHaveLength(1)
    expect(asked[0].startsWith(DOOR_PREFIX)).toBe(true)
    expect(JSON.parse(asked[0].slice(DOOR_PREFIX.length))).toEqual({ tool: MEMORY_TOOL, input: { file: 'room', op: 'add', text: 'ferns' }, callId: 'call-9' })
  })

  it('[U:pi-memory] no channel, no answer, or an error: the model is told nothing was saved', async () => {
    const { tools } = load()
    const run = (ctx: unknown) => tools[MEMORY_TOOL].execute('c', {}, undefined, undefined, ctx as never)
    expect((await run({ hasUI: false, ui: {} })).content[0].text).toMatch(/^Not saved/)
    expect((await run(undefined)).content[0].text).toMatch(/^Not saved/)
    expect((await run({ hasUI: true, ui: { input: async () => undefined } })).content[0].text).toMatch(/^Not saved/)
    expect((await run({ hasUI: true, ui: { input: async () => { throw new Error('gone') } } })).content[0].text).toMatch(/^Not saved/)
  })

  it('[U:pi-memory] the gate lets it through without a select: it asks the door itself when it runs', async () => {
    const { handlers } = load()
    const selects: string[] = []
    const ctx = { hasUI: true, ui: { select: async (t: string) => { selects.push(t); return 'deny' }, notify: () => {} } }
    expect(await handlers.tool_call({ toolName: MEMORY_TOOL, toolCallId: 'c', input: { file: 'room', op: 'add', text: 'x' } }, ctx)).toBeUndefined()
    expect(selects).toEqual([])
    // Every other tool is still asked about.
    expect(await handlers.tool_call({ toolName: 'bash', toolCallId: 'c', input: { command: 'ls' } }, ctx)).toMatchObject({ block: true })
    expect(selects).toHaveLength(1)
  })
})
