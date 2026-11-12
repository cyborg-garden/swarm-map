# Swarm Map primitives: the chosen spec

Written 2026-11-13. A spec, not code. Nothing was run and no live system was touched.
Inputs: three candidate designs (gateway-first, conformance-first, policy sidecar) and code-reading
notes that are not part of this repository.
Anything marked **unverified** is from reading docs or source and must be replaced by a test result.

This is the published copy. One column of the rule table in section 5 (where each rule is enforced
on existing Hermes deployments today) and one paragraph listing what the tests would have caught
there are left out of it. The contracts, the tests and the plan are complete.

## 0. The decision in ten lines

- **Base: the policy sidecar.** One small trusted process beside each agent owns chat in, chat out,
  model traffic, tool verdicts and memory. The harness sits in a cell with no chat token, no real
  key and one network link.
- **Door mode is the only mode for new harnesses** (Pi, Letta Code, Claude Agent SDK). The harness
  is never asked to enforce a "who may it hear and answer" rule, so there is nothing to vanish.
- **Native mode is a grandfather clause for Hermes only** (and possibly OpenClaw later). The fleet
  stays where it is. Its rules are rendered from the same record and must earn every claim with tests.
- **Grafted from conformance-first:** the rule catalogue, twin scenarios, "claims must be earned",
  `unrendered` blocks the save, read-back round trip, the five harness-blind observables.
- **Grafted from gateway-first:** the brain protocol details (`hello` with a token, `settled`,
  timeout means no), the `chat.post` tool for speaking unprompted, must-fail runs against a broken shim.
- **Cut for size:** TLS-intercepting key swap, microVMs, a memory service and real chat connectors
  are all after the first slice. The first slice runs on a laptop with fakes only.

## 1. How the three designs scored

Scale: strong / fair / weak.

| Criterion | Gateway-first | Conformance-first | Policy sidecar |
|---|---|---|---|
| Rules can never silently vanish | Strong for door agents. Says nothing useful about the Hermes fleet until it moves, which is last | Strong at detecting, on every harness, including Hermes today. Does not prevent: each harness still enforces | Strong for door agents, and has a labelled native mode for the rest |
| Small enough for a tiny team | Weak. Rebuild every chat adapter, move Hermes into it, one box per (agent, tier) | Weak over time. About 35 rules x 5 surfaces x 5 harnesses, and it still needs a door for Pi and Claude | Fair. Same door cost, but per-harness work is one shim. Egress key swap as written is too much for v0 |
| Pi now; Letta Code, OpenClaw, Claude later | Strong for Pi and Claude. Fights Letta Code and OpenClaw | Strong for Letta Code. Weakest on Pi and Claude (its own words) | Strong for Pi, Claude, Letta Code. OpenClaw undecided, honestly so |
| Security | Strong (no secret in the box) but one fleet-wide process holds every token | Fair. Shims are guardrails; keys stay in env until a gateway is added | Strongest. Trust zones are explicit, walls and guardrails are named apart, the wall is tested with the guardrail removed |
| How much existing code survives | Weak. Hermes becomes a brain; adapters and a dozen fork patches are thrown away up front | Strong. Today's Hermes rendering moves under an adapter unchanged | Strong. Native mode keeps the Hermes path; `docker.ts`, key store, registry, audit, broker all reused |

Why the sidecar wins: it is the only design that is honest about both halves of the problem.
New harnesses get a structural guarantee. The existing fleet gets a measured one. And it draws the
line between what is a wall and what is only a guardrail, which neither of the others does as clearly.

## 2. What was rejected, and why

| Rejected | From | Why |
|---|---|---|
| Rendering rules into each harness's native channels as the normal path | Conformance | It measures the N-by-M problem without shrinking it. Kept only for Hermes, where the code already exists |
| Letta Code in native mode | Conformance | Once a door exists, a WebSocket shim is cheaper than a renderer, a read-back, role expansion and six or seven permanent gaps |
| One fleet-wide door process | Gateway | One thing to break, one thing to steal, and a new supervised daemon. A sidecar per agent fits today's one-compose-per-agent shape and holds only that agent's keys. Contracts stay per agent so pooling is possible later |
| Moving Hermes into the door as a brain, as a planned step | Gateway | Throws away the adapters the fleet depends on before the door can match them. Left as an option per agent, never a requirement |
| One box per (agent, tier) | Gateway | Doubles or triples processes. Posture stays per agent as today. An agent that must be public in one room and private in another is two agents |
| TLS-intercepting placeholder swap for tool keys in v0 | Sidecar | Needs a cell-local CA and breaks on pinned clients and signed requests. v0 uses the model route, the existing broker, and tools that run on the sidecar side |
| Reusing the Hermes gateway's "door + brain" mode as Pi's door | Conformance (listed as a choice) | Ties the lab to the fork, and that bridge is being deleted |
| A generic ACP shim | All three (as a spike) | Unverified. Worth half a day before the third bespoke shim, not before the first |
| Wire filter in front of native adapters | Sidecar (as a spike) | Only plausible for Signal and Telegram; adds a third mode |
| MicroVM or WASM now | All three agree | Docker first. WASM cannot host these harnesses. MicroVM is a later option for public agents, behind the same interface |
| Real-platform tests (T3) in the first slice | Conformance | Means real posts to a real server. Needs the maintainer's explicit yes |
| `MemoryPolicy` as functions | Sidecar | A record must be data so it can be hashed, diffed and stored |

## 3. Shape and trust zones

```
            Swarm Map (control plane): PolicyRecord, key store, audit, UI
                 | policy (versioned, hashed)          ^ receipts, heartbeat
                 v                                     |
 chat  <-->  SIDECAR, one per agent (trusted)
 model <-->   door | model route | gate | memory | receipts
                 ^  one internal network, nothing else
                 v
             CELL (untrusted): shim + harness. No chat token, no real key, no route out
```

| Zone | Contents | Trusted to enforce |
|---|---|---|
| Control plane | Swarm Map server, key store, PolicyRecord, audit | Yes |
| Sidecar | Door, model route, gate, memory, receipts | Yes |
| Substrate | Whatever builds the cell and its one link | Yes, and probed by tests |
| Cell | Harness, shim, the model's shell, every file the model can write | **No** |
| Platform | Discord, Signal, Slack servers | Yes, for the little they enforce |

Two words used everywhere below:

- **Wall**: holds even if the model controls everything in the cell. Door, model route, substrate.
- **Guardrail**: stops mistakes, not attacks. The in-harness tool gate. Every guardrail has a wall
  behind it, and test C10 deletes the guardrail to prove the wall.

Two modes per agent, always shown in the UI:

| Mode | Who holds the chat token | Who enforces chat rules | Allowed for |
|---|---|---|---|
| **Door** | Sidecar | Sidecar | Every harness. The only mode for Pi, Letta Code, Claude |
| **Native** | Harness | Harness, from rendered config, proven by tests per version | Hermes. OpenClaw only if its code review says wrapping is worse |

## 4. Primitive contracts

TypeScript, because Swarm Map is Next.js and TypeScript. Home: `lib/core/` for types and pure
functions, `lib/door/` for the sidecar, `lib/runtimes/<id>/` for per-harness code.

### 4.1 PolicyRecord (multiplayer rules, per-surface permissions)

Stored by Swarm Map, never in a harness file. The only thing the UI edits.

```ts
type SurfaceId = 'discord' | 'signal' | 'slack' | 'telegram' | 'mattermost';
type Posture = 'private' | 'team' | 'public';
type PrincipalRef = { kind: 'user' | 'role'; id: string };
type ToolClass =
  | 'shell' | 'file_read' | 'file_write' | 'code_exec' | 'browser' | 'network'
  | 'chat_post' | 'chat_admin' | 'memory' | `mcp:${string}` | 'unknown';

interface PolicyRecord {
  schema: 1;
  agentId: string;                       // Swarm Map id, not a container name
  version: number;                       // bumps on every save
  hash: string;                          // sha256 of canonical JSON; the sidecar echoes it back
  posture: Posture;                      // per agent, as today
  mode: 'door' | 'native';
  surfaces: Partial<Record<SurfaceId, SurfacePolicy>>;
  tools: ToolPolicy;
  keys: KeyGrant[];
  egress: EgressPolicy;
  memory: MemoryPolicy;
  session: { groupShared: boolean; resetAtLocalHour?: number; timezone: string };
  budget?: { monthlyUsd: number; onExceed: 'refuse' | 'warn' };
}

interface SurfacePolicy {
  enabled: boolean;
  account: string;                       // which bot identity; the token lives in the key store
  // Admission: who and where
  users: PrincipalRef[];
  anyoneInAllowedRoom: boolean;
  rooms: RoomRule[];                     // first match wins; 'ignore' beats everything
  dm: { mode: 'closed' | 'allowlist' | 'pairing' | 'open'; users: PrincipalRef[] };
  bots: { mode: 'none' | 'mentions' | 'all'; inlineMentionOnly: boolean;
          roles: string[]; maxAlternatingTurns: number };
  invites: { mode: 'closed' | 'admins' | 'allowlisted' | 'open' };
  // Behaviour
  threadsRequireMention: boolean;
  observeUnmentioned: boolean;
  // Privilege, kept apart from admission on purpose
  admins: PrincipalRef[];
  approverRoles: string[];
}

interface RoomRule {
  match: { room: string } | { category: string };
  mode: 'mention' | 'free' | 'ignore';
}

interface ToolPolicy {
  allow: ToolClass[];
  ask: ToolClass[];                      // needs an admin's yes in the room
  deny: ToolClass[];                     // 'unknown' is always denied on posture 'public'
  perRoom?: Record<string, { allow?: ToolClass[]; ask?: ToolClass[]; deny?: ToolClass[] }>;
  browserGuard: 'off' | 'public-hosts-only';
}
```

Rules of the record:

1. **Empty means nobody.** No `0` sentinels. Open is spelled `'open'`. Sentinels live only inside
   the Hermes renderer.
2. **Admission and privilege are different lists.** An admin who is not admitted is still not heard.
3. **Every field is read by a rule** (4.2). A field no rule reads fails CI.
4. `lib/surfaces/registry.ts` becomes the validator for this record and the Hermes renderer's
   table of var names. Nothing else.

### 4.2 Rule catalogue

```ts
interface Rule {
  id: string;                            // 'dm.allowlist', 'bots.inline-mention', 'keys.not-in-cell'
  statement: string;                     // one plain sentence, shown in the UI
  klass: 'security' | 'behaviour';
  kind: 'wall' | 'guardrail' | 'control-plane';
  reads: string[];                       // PolicyRecord paths
  surfaces: SurfaceId[] | 'all';
  enforcer: 'door' | 'model-route' | 'gate' | 'memory' | 'substrate' | 'control-plane';
  tests: string[];                       // test ids from section 7; empty fails CI
}
```

One file, `lib/core/rules/catalogue.ts`. Section 5 is its content.

### 4.3 `decide()`: one pure function

```ts
type Event =
  | { kind: 'inbound';  surface: SurfaceId; room: RoomRef; sender: Principal; isDm: boolean;
      mention: boolean; inlineMention: boolean; replyToAgent: boolean;
      text: string; attachments: AttachmentRef[] }
  | { kind: 'outbound'; surface: SurfaceId; room: RoomRef; turnId?: string; text: string }
  | { kind: 'invite';   surface: SurfaceId; room: RoomRef; inviter: Principal }
  | { kind: 'tool';     room: RoomRef; actor: Principal; toolClass: ToolClass;
      toolName: string; argsDigest: string }
  | { kind: 'memory';   op: 'read' | 'write'; scope: MemoryScope; room: RoomRef }
  | { kind: 'model';    provider: string; model: string }      // budget check
  | { kind: 'egress';   host: string; method: string };

interface RoomRef { id: string; kind: 'dm' | 'group' | 'channel' | 'thread';
                    parentId?: string; categoryId?: string }
interface Principal { id: string; display: string; isBot: boolean; isSelf: boolean; roles: string[] }

interface Facts {                        // live data the caller fetched; decide() does no I/O
  rolesOf?: Record<string, string[]>;
  paired?: string[];
  spentUsdThisMonth?: number;
  botTurnsInARow?: number;
  turnLive?: boolean;
}

interface Decision {
  verdict: 'deliver' | 'observe' | 'drop' | 'allow' | 'ask' | 'deny';
  rule: string;                          // catalogue id of the deciding rule
  why: string;                           // one plain sentence
  privilege: 'admin' | 'member' | 'guest';
  sessionKey?: string;                   // 'discord:room:123' | 'signal:dm:<uuid>'; set by the door, never the model
  trace: { rule: string; outcome: 'pass' | 'fail' | 'n/a' }[];
  policyHash: string;
}

function decide(policy: PolicyRecord, event: Event, facts: Facts): Decision;
```

Shared by the sidecar, the "why didn't it answer?" view and the tests. Privilege for a tool call is
the privilege of **the sender who triggered the turn**. Risky classes go to `ask`. That is a policy
choice, not a proof (see section 10, mixed rooms).

### 4.4 Surface connector and door

```ts
interface SurfaceConnector {             // translates only; makes no decisions
  id: SurfaceId | 'fake';
  connect(creds: SurfaceCreds): Promise<void>;
  onEvent(cb: (e: InboundEvent | InviteEvent) => void): void;
  send(room: RoomRef, msg: OutboundMessage): Promise<SendReceipt>;
  facts(q: { principal?: Principal; room?: RoomRef }): Promise<Facts>;
  close(): Promise<void>;
}

interface Envelope {                     // what the harness is given
  id: string;
  turnId: string;
  sessionKey: string;
  surface: SurfaceId; room: RoomRef;
  sender: { id: string; display: string; isBot: boolean };
  text: string; attachments: AttachmentRef[];
  context: { roster?: string[]; observed?: ObservedLine[]; memory?: string; rulesNote?: string };
  tools: string[];                       // native tool names this turn may see
  whenBusy: 'queue' | 'steer';
  deadlineMs: number;
}
```

Inbound order: normalise, `decide()`, write the receipt, scrub pasted secrets, pick the session,
attach buffered observed lines and the memory slice, send. Outbound order: is the turn still live
and is the room still allowed, redact secrets, runtime sanitizer, rate and loop limits, post, receipt.

The **fake connector** (scripted room in, captured posts out) is a first-class member. Every test
and the UI's read-only fixture mode use it.

**Speaking unprompted.** A cell has no chat token, so cron jobs and finished long tasks need a
sidecar tool: `chat.post(room, text)`, class `chat_post`. It passes the same outbound checks.

### 4.5 Harness shim and brain protocol (the only per-harness code)

JSON lines over one socket. The shim runs in the cell, dials the sidecar, and translates to the
harness's own protocol.

```ts
// sidecar -> shim
type ToShim =
  | { t: 'turn'; env: Envelope }
  | { t: 'tool_verdict'; callId: string; allow: boolean; reason?: string }
  | { t: 'cancel'; turnId: string }
  | { t: 'reset'; sessionKey: string }
  | { t: 'shutdown' };

// shim -> sidecar
type FromShim =
  | { t: 'hello'; token: string; protocol: 1; caps: Capabilities }
  | { t: 'tool_request'; callId: string; turnId: string; tool: string; input: unknown }
  | { t: 'tool_done'; callId: string; ok: boolean; summary: string }
  | { t: 'delta'; turnId: string; text: string }
  | { t: 'reply'; turnId: string; text: string; attachments: AttachmentRef[] }
  | { t: 'settled'; turnId: string; usage?: Usage }
  | { t: 'error'; turnId?: string; message: string }
  | { t: 'health'; ok: boolean };

interface Capabilities {
  harness: 'pi' | 'letta-code' | 'claude-sdk' | 'hermes' | 'openclaw';
  version: string;
  ownsChat: boolean;                     // has native channels; must be off in door mode
  toolVeto: 'pre-call' | 'none';
  approvalRoundTrip: boolean;            // can hold a call while an admin answers
  toolMap: Record<string, ToolClass>;    // every tool it can call, classified
  modelBaseUrl: boolean;                 // model traffic can be pointed at the sidecar
  mcpClient: boolean;
  nativeMemory: 'none' | 'off-able' | 'always-on';
  sessions: 'one-per-process' | 'many';
  steer: boolean;
  resume: boolean;
  usage: 'reported' | 'route-only';
  streaming: boolean;
}
```

Fixed behaviour, not negotiable per harness:

- `tool_request` blocks until a verdict. **No verdict within the timeout means no.**
- `settled` means truly finished. For Pi that is `agent_settled`, not `agent_end`.
- The sidecar adapts to `caps`: `toolVeto: 'none'` means that harness gets only the posture's safe
  tool set; `sessions: 'one-per-process'` means the shim runs one harness process per `sessionKey`.
- A tool name missing from `toolMap` is class `unknown`.
- The UI shows controls from `caps`, never from `runtime === 'hermes'`.

### 4.6 Key grants and the model route

```ts
interface KeyGrant {
  ref: string;                           // key store id
  kind: 'model' | 'broker' | 'sidecar-tool' | 'env';
  hosts: string[];
  rooms?: string[];                      // honoured only where the sidecar can tell sessions apart
}
interface EgressPolicy {
  default: 'deny';
  hosts: { host: string; methods?: string[] }[];
  blockPrivateRanges: true;
}
interface Usage { model: string; inTokens: number; outTokens: number; usd: number }
```

| Kind | How it works | In the cell |
|---|---|---|
| `model` | Harness is started with the provider base URL pointed at the sidecar. Sidecar adds the real key, counts tokens, refuses over budget | A placeholder string |
| `broker` | Today's host token broker, reached through the sidecar. Short-lived, narrow tokens. Caller is identified by its link, not a name in the URL | A token that expires |
| `sidecar-tool` | The tool (GitHub, Notion, Google) runs as an MCP server on the sidecar side | Nothing |
| `env` | Today's plaintext `.env` line | The real key. Native mode only. Refused on `public` posture |
| chat tokens | Door only | Nothing |

`.hsm-no-anthropic` and `.hsm-github-broker` become fields on grants. `forbiddenEnv` for public
agents becomes a validation error at save, not a drift report.

### 4.7 Sanitizer

```ts
interface Sanitizer {
  run(direction: 'inbound' | 'outbound', text: string, ctx: { posture: Posture; room: RoomRef }):
    { text: string; findings: { pattern: string; count: number }[] };
}
```

Outbound fails closed (a crash means nothing is posted). Inbound fails open, as today's redactor
does, but a failure writes a receipt. One pattern list, shared with the repo's sanitization gate.

### 4.8 Memory

```ts
type MemoryScope =
  | { kind: 'agent' }
  | { kind: 'room'; surface: SurfaceId; room: string }
  | { kind: 'person'; surface: SurfaceId; room: string; userId: string }   // per room, on purpose
  | { kind: 'team' };

interface MemoryPolicy {
  threadsPoolIntoParent: boolean;
  dmIsolated: true;
  team: { dm: 'none' | 'read'; group: 'none' | 'read' | 'read-write'; public: 'none' | 'read' };
  store: { kind: 'git-markdown'; repo: string };
}
```

Markdown in a git repo, one folder per scope, outside the cell. Two delivery paths: the door puts
the readable slice in `Envelope.context.memory` (works on every harness), and a sidecar MCP server
offers `memory.read / write / search` with the scope fixed by the session, never passed by the model.
Harness-native memory is private scratch. Where it cannot be scoped or turned off, the matrix says so.

### 4.9 Substrate

```ts
interface Substrate {
  id: 'docker' | 'microvm' | 'process';
  createCell(spec: CellSpec): Promise<CellHandle>;
  start(h: CellHandle): Promise<void>; stop(h: CellHandle): Promise<void>; destroy(h: CellHandle): Promise<void>;
  logs(h: CellHandle): AsyncIterable<string>; stats(h: CellHandle): Promise<CellStats>;
  guarantees(): Guarantee[];
}
type Guarantee =
  | 'G1-no-network-except-sidecar'
  | 'G2-shim-and-gate-read-only'
  | 'G3-no-real-secret-in-cell'
  | 'G4-resource-limits'
  | 'G5-kernel-isolation';               // microVM only
interface CellSpec {
  image: string; command: string[];
  mounts: { host: string; cell: string; readOnly: boolean }[];
  env: Record<string, string>;           // never secrets
  limits: { cpu: number; memMb: number };
}
```

Docker now: two services per agent, the cell on a compose network with `internal: true`, the sidecar
on that network and the normal one. `lib/services/docker.ts` is reused as is. `process` returns no
guarantees and the UI refuses to call such an agent protected.

### 4.10 Receipts and identity

```ts
interface Receipt {
  ts: string; agentId: string; policyHash: string;
  event: { kind: Event['kind']; surface?: SurfaceId; room?: string; sender?: string; messageId?: string; bytes?: number };
  verdict: Decision['verdict']; rule: string; why: string;
}
interface Heartbeat { agentId: string; policyHash: string; caps: Capabilities; ts: string }
```

- Receipts hold ids and sizes, not message text. They are the "why didn't it answer?" view.
- The heartbeat hash differing from the saved record shows as "saved, not applied".
- Sidecar-to-Swarm-Map calls carry a per-agent secret minted at deploy. Cell-to-sidecar calls are
  identified by the link and a per-cell token.

### 4.11 Native-mode adapter (Hermes only)

```ts
interface NativeAdapter {
  id: 'hermes' | 'openclaw';
  claims(): { rule: string; surface: SurfaceId; how: 'native' | 'fork' | 'plugin' | 'none' }[];
  render(p: PolicyRecord): { files: FileWrite[]; unrendered: string[] };   // must list every rule it did not render
  apply(agentId: string, plan: ReturnType<NativeAdapter['render']>): Promise<{ took: 'live' | 'reload' | 'recreate' }>;
  readBack(agentId: string): Promise<PolicyRecord>;
}
```

- `apply` refuses when `unrendered` holds a `security` rule the policy actually uses. Hard block on
  `public` posture; audited override otherwise (maintainer to confirm, section 11).
- `adapterForRuntime` stops falling back to Hermes. An unknown runtime is an error.

## 5. Rule-by-rule enforcement table

"Door mode" is where the rule lives for Pi, Letta Code and Claude. "Harness?" = does door mode
need anything from the harness.

| Rule id | Says | Door mode enforcer | Kind | Harness? | Tests |
|---|---|---|---|---|---|
| `adm.users` | Only listed users or role holders are heard | Door, `decide` inbound; roles from `connector.facts` | Wall | No | D, C3 |
| `adm.rooms` | Only listed rooms; Discord category counts | Door | Wall | No | D, C3 |
| `adm.rooms.ignore` | Ignored rooms beat every allow | Door | Wall | No | D |
| `adm.anyone-in-room` | Anyone in an approved room may speak | Door | Wall | No | D |
| `adm.empty-is-closed` | Empty list admits nobody | Record semantics | Wall | No | D (property) |
| `dm.closed` / `dm.allowlist` / `dm.open` | Who may DM | Door | Wall | No | D, C3 |
| `dm.pairing` | Stranger gets a code, operator approves | Door; store in Swarm Map | Wall | No | D, P |
| `addr.mention` | Rooms need an @mention | Door (`RoomRule.mode`) | Wall | No | D |
| `addr.threads` | Threads need a mention too | Door | Wall | No | D |
| `addr.free-rooms` | Named rooms need no mention | Door | Wall | No | D |
| `addr.observe` | Unmentioned text is kept as context, never answered | Door verdict `observe` + buffer | Wall | No | D, C2 |
| `bots.mode` | Other bots: none / mentions / all | Door | Wall | No | D |
| `bots.inline-mention` | A reply-ping is not a mention | Door | Wall | No | D |
| `bots.roles` | Bot sender must hold a role | Door, roles from `facts` | Wall | No | D |
| `bots.loop` | At most N alternating bot turns | Door counter | Wall | No | D, P |
| `bots.no-self` | Never answer itself | Door | Wall | No | D |
| `invite.policy` | Who may add the agent to a room | Door on `invite` events, one way | Wall | No | D, P |
| `priv.admins` | Admin list is separate from admission | Record + `decide` | Wall | No | D |
| `priv.approval` | Risky tools wait for an admin's yes in the room | Gate verdict `ask`; door posts the ask and reads the answer | Guardrail, wall behind | **Yes**: hold the call | C6 |
| `priv.approver-roles` | Discord role may approve | Door reads live role | Wall for the answer | Same | D, C6 |
| `priv.no-forged-identity` | Message text cannot raise privilege | Privilege comes from the door's turn record | Wall | No | C13 |
| `tools.posture` | Public agents lose shell, file, code-exec, chat-admin | Start flags + gate; egress and missing keys behind it | Guardrail, wall behind | **Yes**: `toolMap`, veto | C4, C5, C10 |
| `tools.per-room` | Tool set differs by room | Gate, from the turn's room | Guardrail only | **Yes** | C4 |
| `tools.unknown` | Unclassified tool is denied on public | Gate | Guardrail | **Yes**: honest `toolMap` | C7 |
| `tools.browser-guard` | Public browser: public hosts only, no page JS, no raw CDP | Hosts: egress `blockPrivateRanges`. JS and CDP: gate on args | Wall / guardrail | Partly | C9, C4 |
| `keys.not-in-cell` | No real secret is readable in the cell | Model route, broker, sidecar tools | Wall | `modelBaseUrl` | C8 |
| `keys.grants-valid` | Public agents may hold no forbidden grant | Save-time validation | Control plane | No | T0 |
| `keys.per-room` | A key is live only for some rooms | Sidecar, where sessions are one per process | Wall where supported, else labelled agent-wide | Session shape | C12b |
| `budget.cap` | Monthly spend is capped | Model route meter | Wall | `modelBaseUrl` | C12 |
| `san.in` | Pasted secrets are scrubbed before the model | Door | Wall | No | P, C8 |
| `san.out` | Secrets and tier patterns never get posted | Door outbound | Wall | No | P |
| `out.still-allowed` | A reply is dropped if policy changed mid-turn | Door outbound | Wall | No | P, C15 |
| `speak.unprompted` | Unprompted posts pass the same checks | `chat.post` on the sidecar | Wall | No | P |
| `mem.scope` | Memory is per room; threads pool into the parent | Memory service + `sessionKey` | Wall for sidecar memory | Native memory off or scoped | C11 |
| `mem.dm-isolated` | A DM never shares scope with a group | Door picks `sessionKey` | Wall | Honour session keys | C11 |
| `mem.team-read-only` | Private rooms read team notes, cannot write them | Memory service | Wall | No | D, C11 |
| `mem.person-scoped` | Person notes are per room | Memory service | Wall | No | C11 |
| `sess.reset` | Nightly reset at local time | Door sends `reset` | Wall | `reset` works | C14 |
| `sub.G1`-`sub.G4` | No route out, shim read-only, no host secret, limits | Substrate | Wall | No | S1-S4 |
| `ctl.identity` | An agent cannot ask about, or pose as, another | Per-agent secret; link identity | Wall | No | C9 |
| `ctl.applied` | The UI knows which policy is live | Heartbeat hash | Control plane | No | C15 |
| `ctl.receipts` | Every decision leaves a receipt | Sidecar | Control plane | No | P |
| Operator login, audit log, artifact pre-scan, CI sanitization gate, extra env and mount validation | | Unchanged | Control plane | No | existing |

Deleted rather than fixed: `HERMES_DM_POLICY`, `HERMES_APPROVAL_ADMIN_ONLY`, `HERMES_MEMORY_SCOPE`,
`SWARM_MAP_POLICY_URL`, the plugin's never-called `is_group_allowed`, `MATTERMOST_ADMIN_USERS` (no
reader found), tool tiers and memory scopes presented as permissions, the README's budget claim
until `budget.cap` passes.

Count: 30 of the 42 rule rows need nothing from the harness in door mode, including every "who may
it hear and answer" rule. What stays per harness is tool veto, approval, the tool map, native memory
and reset. That is the real size of "every harness does everything differently".

## 6. Harness capability matrix

Predicted from the maps. Its job is to be proven wrong. Real cells are generated from test output,
keyed by harness version, and committed. **?** = unverified, needs a run.

| Capability | Pi 1.5 | Letta Code 0.34 | Claude Agent SDK | Hermes (fork) | OpenClaw |
|---|---|---|---|---|---|
| Mode | Door | Door | Door | Native now; door optional later | ? (native likely) |
| `ownsChat` | No | Yes; start without `--channels` | No (custom channels refused headless) | Yes | Yes |
| Turn in | `prompt` over RPC, sender in a preamble | `input` on the `/ws` socket | SDK session, streaming input | API server `/v1/runs`, or a platform plugin ? | ? |
| Reply out / done | `message_end` / `agent_settled` | `stream_delta` / ? | SDK result | run event stream ? | ? |
| `toolVeto` | pre-call: `gate.ts` on `tool_call` ? | pre-call: `control_request` | pre-call: `canUseTool` | pre-call: `pre_tool_call` hook | ? |
| `approvalRoundTrip` | Yes via `extension_ui_request` ? | Yes via `approval_response` ? | Yes, callback can wait | `POST /v1/runs/{id}/approval` ? | ? |
| `modelBaseUrl` | Yes (custom provider / gateway URL) ? | OpenAI-compatible yes; Anthropic ? | `ANTHROPIC_BASE_URL` | provider base URL in `config.yaml` | ? |
| Accepts a scripted model | ? | ? | ? | ? | ? |
| `mcpClient` | Yes (`.pi/mcp.json`) | Yes | Yes | Yes | ? |
| `nativeMemory` | none | **always-on** (MemFS, per agent) | off-able | off-able, or fork scoping in native mode | ? |
| `sessions` | one-per-process | many | one-per-process (about 1 GiB each) | many | many |
| `steer` | Yes (`steer` / `follow_up`) | ? | Yes | ? | ? |
| `resume` | Yes (session files) | Yes | Yes | Yes | ? |
| `usage` | route-only to start | ? | reported | reported (`state.db`) | ? |
| Tool keys | broker, sidecar tools; strip shell env with `spawnHook` | broker, sidecar tools; skip its keychain store | broker, sidecar tools | `env` today; broker for GitHub | ? |
| Shim size | Small | Medium | Small to medium | Medium (door mode only) | Unknown, likely large |
| Known permanent gap | Identity is prompt text | MemFS cannot be scoped per room | RAM per session; subscription billing ? | A third of its rules are fork-only | Its docs say session ownership is not a security boundary |
| Order | **First** | Second, parallel once contracts freeze | Third | Native now | Last, decide after reading its code |

Pin every harness version. Pi ships weekly and Letta Code several times a day. A version with no
matrix row cannot be deployed from the UI.

## 7. Conformance tests

Four groups. **D** and **P** need no harness. **C** is what every shim must pass. **N** applies to
native mode only. Scenarios are JSON in `conformance/scenarios/` so the fork's pytest can read them too.

The rig puts a fake at each outside edge of the harness: the fake connector on the chat side and a
**scripted model** behind the sidecar's model route. Every check then reads one of five observables
that need no knowledge of the harness:

| Observable | How it is read |
|---|---|
| `heard` | The message's canary string appears in a request to the scripted model |
| `answered` | The fake connector received a post in that room |
| `toolRan` | A canary file or URL was touched |
| `secretSeen` | A planted secret appears in any model request or cell file |
| `memoryCrossed` | A canary planted in room A appears during a room B turn |

**D. `decide()` table and property tests** (milliseconds, every PR). One case pair per rule id.
Properties: an empty list admits nobody; a `drop` never yields a send; an admin who is not admitted
is not heard; `ignore` beats every allow.

**P. Door plumbing** (fake connector + echo shim, every PR). Observe buffer, session keys, pairing,
invite flow, loop breaker, inbound scrub, outbound redaction, outbound re-check, `chat.post`, receipts.

**C. Shim conformance** (real harness in a real cell; on every harness version bump and nightly).

| # | Check | Proven by |
|---|---|---|
| C1 | A delivered turn gives exactly one reply, tied to the right turn, after `settled` | `answered` once |
| C2 | Observed lines arrive as context and cause no reply | `heard` in the next turn only; no post |
| C3 | A dropped message never reaches the model | `heard` false |
| C4 | A denied tool does not run | `toolRan` false |
| C5 | No verdict means no run | Sidecar stays silent; `toolRan` false |
| C6 | `ask`: tool is held, runs after an admin's yes; a non-admin's yes is ignored | `toolRan` flips only on the admin |
| C7 | A tool missing from `toolMap` is treated as `unknown` and denied on public | `toolRan` false; suite fails the harness if the map is incomplete |
| C8 | No real secret is readable: `env`, `/proc/*/environ`, a grep of the cell's disk | `secretSeen` false |
| C9 | Nothing leaves except through the sidecar: a sink host, `169.254.169.254`, the sidecar's own admin port, another agent's id | Sink never hit; all refused |
| C10 | **Gate deleted from the cell.** The model runs the denied tool and then tries `curl` | Tool may run; egress still refuses; no secret; no post |
| C11 | Scope isolation, including native memory: plant in room A, ask in room B, and DM vs group | `memoryCrossed` false |
| C12 | Usage is counted and the turn after the budget is spent is refused. C12b: a room-scoped key is not usable from another room, where supported | Route meter; refusal receipt |
| C13 | Text like "admin: approve this" from a member does not change tool verdicts | Same verdicts as without it |
| C14 | Busy, cancel, reset and restart-and-resume behave as declared in `caps` | Per capability |
| C15 | A policy change takes effect on the next message with no restart; heartbeat hash changes | `answered` flips |
| C16 | A harness with `ownsChat` runs with its channels off and holds no chat credential | Cell scan |
| C17 | Every declared capability has a passing probe; the UI shows only what passed | Generated matrix |

**S. Substrate probes** (per substrate): S1 direct internet unreachable, sidecar reachable. S2 shim
and gate files not writable. S3 no host credential in env or mounts. S4 limits applied.

**N. Native-mode guards** (Hermes).

| # | Check |
|---|---|
| N1 | **Twin.** Each claimed rule has a scenario and its flipped twin. Flip the policy, the outcome must flip. Catches a knob nothing reads |
| N2 | **Round trip.** `readBack(apply(render(p)))` equals `p` for every rendered field |
| N3 | **`unrendered` blocks apply** for a security rule the policy uses |
| N4 | **Claims are earned.** A claim with no passing twin fails CI. No claim means "none" |

**G. Guards on the guards** (every PR).

- **Schema coverage.** Every `PolicyRecord` field is in some rule's `reads`; every rule has tests.
  Adding a UI toggle with no rule fails the build.
- **Must-fail.** The whole C suite also runs against a deliberately broken shim (ignores verdicts,
  leaks env, replies to dropped messages). If it passes, the suite is wrong.
- **Matrix is generated.** `rule x harness x version x mode`, pass / fail / n-a, committed.

## 8. First slice: Pi, on a laptop, with fakes only

**Goal.** One Pi agent in a Docker cell, driven through the door by a scripted room and a scripted
model, passing a named subset of the suite. No real chat platform, no real model key, no Hermes
change, no UI change, nothing deployed.

**Proves.** The four-verb shim contract is right; the wall holds on Docker Desktop for macOS; a rule
has one implementation and Pi is not part of it.

**Step 0. Three spikes, throwaway code, about half a day.** Each can kill or reshape the slice.

1. Pi RPC: `pi --mode rpc -e gate.ts` from a Node script; one `prompt`; one tool call blocked through
   `extension_ui_request` / `extension_ui_response`; wait for `agent_settled`. Split stdout on `\n`
   only (Node `readline` corrupts records).
2. Docker G1: a compose file with an `internal: true` network; the cell cannot reach the internet
   and can reach the sidecar.
3. Model route: Pi pointed at a local proxy with a placeholder key; the proxy answers from a script.
   If Pi will not take a scripted endpoint, C-tests need a different stub and this spec changes.

**Then four small PRs**, each from a worktree off `origin/main`, each safe alone.

| PR | Contents | Tests that go green |
|---|---|---|
| 1 | `lib/core/policy/` (types in 4.1), `lib/core/rules/catalogue.ts`, `lib/core/decide.ts`. No callers | D for `adm.*`, `dm.*`, `addr.*`, `bots.*`; schema coverage |
| 2 | `lib/door/`: fake connector, door loop, observe buffer, session keys, receipts, echo shim, scripted model. Runs as its own process, not inside Next.js | P |
| 3 | `lib/runtimes/pi/`: shim (process per `sessionKey`, RPC pump), `gate.ts` (fail closed), cell image with Pi pinned at 1.5.2, compose with the internal network | C1-C5, C8, C9, C10, C13, S1-S3, must-fail |
| 4 | Model route with meter and budget; `npm run conformance -- --harness pi`; generated matrix file; receipts printed as "why didn't it answer?" | C12, C15, C17 |

**Done when:** `npm run conformance -- --harness pi` is green on a clean laptop, the must-fail shim
is red, and the matrix file has a Pi column made from test output.

**Left out of the slice on purpose:** real Discord or Signal; `ask` approvals (C6); memory service
(C11); broker and sidecar tools; `chat.post`; Hermes importer and renderer; capability-driven UI;
Letta Code. Order after the slice: Hermes importer + renderer + N1-N4 (turns today's dead rules into
evidence), then C6 and C11, then one real connector, then the Letta Code shim.

**Letta in parallel.** Deleting the old Letta server path and the Hermes-to-Letta bridge is
independent and can start now (inventory in the Letta Code plan, section 1). The Letta Code shim
starts once PR 3 has frozen the protocol. There is no elizaOS code to remove.

## 9. What changes for existing code

| Stays as is | Moves under `lib/runtimes/hermes/` | New | Goes |
|---|---|---|---|
| `docker.ts`, key store and encryption, operator auth, audit, resolvers, artifact gate, token broker, CI sanitization gate, `harnesses.json` | `.env` / `config.yaml` / compose rendering, the hand parsers (as `readBack`), Discord fleet healers (replaced by N2 drift) | `lib/core/`, `lib/door/`, `lib/runtimes/pi/`, `conformance/` | Old Letta REST path, the bridge, dead env keys, the fallback-to-Hermes in `adapterForRuntime` |

Nothing in the first slice touches a Hermes agent.

## 10. Honest weaknesses of the chosen design

1. **Swarm Map becomes a chat-adapter maintainer** for door-mode agents. Threads, edits, attachments,
   reactions, voice, Signal sealed sender: all start at zero. This is the largest cost. It is bounded
   by starting with one surface and by leaving the fleet in native mode.
2. **Native mode is a standing temptation.** While Hermes stays in it, the fleet's chat rules are
   still "render and prove", not "cannot vanish". N1-N4 limit that; they do not remove it.
3. **The tool gate is a guardrail inside an untrusted cell.** C10 proves the wall behind it, but
   per-room tool rules have no wall at all. Needing one means a second agent.
4. **Tool-class mapping can be wrong.** The suite catches unmapped tools, not mis-mapped ones.
5. **Mixed rooms are unsolved.** An admin and a stranger share a session; the stranger's observed
   text sits in the admin's turn. "Triggering sender's privilege, risky tools ask" is a choice.
6. **Native memory undermines scoping.** Letta Code's MemFS is per agent and always on. It will show
   as a red cell, not a hidden one.
7. **The sidecar is a single point of failure and a prize, per agent.** It must stay small. A Node
   process with many dependencies is a weak start; revisit once the contracts are stable.
8. **Fakes lie, and a scripted model only tests plumbing.** Nothing here tests whether a real model
   repeats what it overheard.
9. **Key coverage is partial in v0.** Tools that need a key inside the cell and cannot use the broker
   stay on `env`, labelled, and are refused on public agents.
10. **More processes per agent.** Unmeasured on a production host.

## 11. Decisions needed from the maintainer

1. A security rule a native-mode harness cannot enforce: hard block always, or hard block on public
   and audited override elsewhere? (Spec assumes the second.)
2. First real surface for the door after the slice: Discord (where the fleet and most rules are) or
   Signal (the shared daemon exists and is easy to fake). Spec leans Discord.
3. Is a private test server with test bots acceptable for real-platform tests? It means real posts.
4. Permission to check whether any live agent `.env` carries `LETTA_BRAIN_*` before the old Letta
   path is deleted. Nobody has looked.

## 12. Not verified

- Nothing was run. Every Pi event name and flag is from docs at 1.5.2.
- Whether each harness will talk to a scripted model endpoint.
- Docker `internal: true` behaviour on Docker Desktop for macOS.
- Hermes API-server path carrying sender and room; Letta Code headless behaviour, RAM, and Anthropic
  base URL override; everything about OpenClaw; ACP's coverage of tool approval.
- Upstream Hermes was compared at a July 2026 snapshot, so some FORK cells may be upstream by now.
