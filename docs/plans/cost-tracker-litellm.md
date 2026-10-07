# Cost Tracker for Hermes Swarm Map

## Status: Plan (research complete, no code written)

## What Cost Data Already Exists

### 1. Per-agent SQLite state.db (PRIMARY SOURCE)

Each agent has `~/.hermes-{name}/state.db` with a `sessions` table containing:

```sql
estimated_cost_usd REAL,  -- per-session estimated cost
actual_cost_usd REAL,     -- reserved, currently NULL
cost_status TEXT,          -- "estimated" | "included" | "unknown"
cost_source TEXT,          -- "official_docs_snapshot" | "provider_models_api" | "none"
input_tokens INTEGER,
output_tokens INTEGER,
cache_read_tokens INTEGER,
cache_write_tokens INTEGER,
reasoning_tokens INTEGER,
billing_provider TEXT,
billing_base_url TEXT,
billing_mode TEXT,
started_at REAL,          -- unix timestamp
ended_at REAL,
model TEXT,
```

**Known problem:** agents that route through a LiteLLM proxy show `estimated_cost_usd = 0.0` and `cost_status = "unknown"`. This is because they call the proxy (`http://litellm-proxy:4000/v1`), and `usage_pricing.py` can't resolve pricing for the proxied model names. The proxy obscures the real provider — `resolve_billing_route` sees `base_url=litellm-proxy:4000` and falls back to "unknown" billing mode.

Token counts ARE populated and accurate — `SUM(input_tokens + output_tokens)` over `sessions` returns real totals even while every `estimated_cost_usd` is `0.0`.

### 2. Hermes usage_pricing.py (COMPUTATION ENGINE)

Rich cost model in `agent/usage_pricing.py`:
- `CanonicalUsage` dataclass: input, output, cache_read, cache_write, reasoning tokens
- `estimate_usage_cost()` returns `CostResult` with amount_usd, status, source
- Hardcoded pricing for Anthropic, OpenAI, DeepSeek, Google models
- OpenRouter pricing via API
- Per-token computation with cache-aware pricing

This runs per API call inside `run_agent.py` (line ~8594) and accumulates into `session_estimated_cost_usd`.

### 3. Gateway session state (IN-MEMORY)

`gateway/session.py` `SessionEntry` has `estimated_cost_usd` and `cost_status` fields, serialized to JSON session files. Same data as state.db but ephemeral.

### 4. LiteLLM Proxy

A `litellm-config.yaml` maps model aliases to providers (illustratively, `claude-sonnet-4` → Bedrock, `gemini-flash` → Vertex AI). LiteLLM has a `/spend` API but it requires database configuration (PostgreSQL or SQLite), which a default proxy setup does not enable. Without `database_url` in the config, LiteLLM does not track spend.

### 5. HSM UI (PLACEHOLDER)

`costToday` already exists on the `Harness` type and renders in:
- Dashboard stat card: `$0.00` total
- Harness card: `$0.00` per agent
- Harness detail page: Usage section

All show `$0.00` because the value defaults to `0` and is never populated from real data.

---

## Proposed Architecture

### Data Flow

```
state.db (per agent)  -->  /api/harnesses/[id]/usage  -->  UI components
  SQLite query               Next.js API route              React client
```

### Why state.db (not LiteLLM, not log parsing)

| Option | Pros | Cons |
|--------|------|------|
| **state.db** (recommended) | Already has token counts; structured SQL; per-session granularity; works now | Cost estimates are $0 due to proxy routing (fixable) |
| LiteLLM /spend API | Would capture actual provider costs | Requires PostgreSQL setup; off by default; adds infra dependency |
| Log parsing | No setup needed | Unstructured; fragile; no cost data in logs currently |
| Agent socket/API | Real-time | Agents don't expose a cost endpoint; would need upstream changes |

**The fix for $0 costs:** HSM can re-compute costs server-side. It knows the LiteLLM config mapping (`claude-sonnet-4` -> `bedrock/anthropic.claude-sonnet-4`). Given token counts from state.db + model name resolution, HSM can apply the same pricing table that `usage_pricing.py` uses, but with the real provider resolved.

### MVP Scope

1. **New API endpoint:** `GET /api/harnesses/[id]/usage`
   - Opens `~/.hermes-{name}/state.db` read-only
   - Queries sessions table for today's totals and historical data
   - Returns: `{ costToday, costWeek, costMonth, totalTokens, sessions: [...] }`

2. **Server-side cost re-computation:**
   - Map model names through LiteLLM config to resolve real providers
   - Apply `usage_pricing.py`-equivalent pricing tables in TypeScript
   - Use token counts from state.db + resolved model to compute accurate costs

3. **Populate `costToday` on harness list:**
   - In `HarnessService.list()`, query each agent's state.db for today's cost
   - Replace the hardcoded `0` with real data

4. **Enhanced harness detail page:**
   - Replace static "Cost today: $0.00" with live data from `/api/harnesses/[id]/usage`
   - Add cost breakdown by model and time period

### Full Feature (post-MVP)

- **Cost history chart:** daily/weekly/monthly cost trends per agent
- **Fleet-wide dashboard:** total spend across all agents with breakdown
- **Budget alerts:** warn when an agent approaches a cost threshold
- **LiteLLM spend integration:** if/when LiteLLM database is enabled, use actual provider-reported costs instead of estimates
- **Per-conversation cost:** drill into individual session costs

---

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `app/api/harnesses/[id]/usage/route.ts` | API endpoint: query state.db, compute costs |
| `lib/services/usage.ts` | Service: SQLite reader + pricing logic |
| `lib/pricing.ts` | Model pricing table (port from usage_pricing.py) |

### Modified Files

| File | Change |
|------|--------|
| `lib/services/harness.ts` | Call `UsageService` during `list()` to populate `costToday` |
| `lib/services/index.ts` | Register `UsageService` |
| `app/(dashboard)/harnesses/[id]/page.tsx` | Fetch `/usage` endpoint, render richer usage section |
| `app/(dashboard)/page.tsx` | Cost stat card now shows real data (automatic via harness.costToday) |
| `components/harness/harness-card.tsx` | Already renders costToday -- works automatically |

### Dependencies

- `better-sqlite3` — read-only access to agent state.db files (already a common Next.js SQLite library, no native compilation issues on macOS)

---

## Implementation Notes

### SQLite Access Pattern

```typescript
// Pseudocode for usage service
const db = new Database(stateDbPath, { readonly: true })
const todaySessions = db.prepare(`
  SELECT model, SUM(input_tokens) as input, SUM(output_tokens) as output,
         SUM(cache_read_tokens) as cache_read, SUM(cache_write_tokens) as cache_write,
         COUNT(*) as session_count
  FROM sessions
  WHERE started_at >= ?
  GROUP BY model
`).all(todayStartUnix)
```

### Model Name Resolution

HSM already reads `litellm-config.yaml` to know the proxy mapping. The pricing lookup needs:
1. `claude-sonnet-4` (what state.db records) -> resolve via litellm config -> `anthropic` provider
2. Apply Anthropic pricing: $3/M input, $15/M output, cache-aware rates
3. Multiply by token counts from state.db

### Data Freshness

state.db is written by the running agent process. Reads are safe (SQLite WAL mode handles concurrent access). Data is as fresh as the last API call the agent made — typically seconds-old for active agents.

### Cost Status

The API should return `cost_status` alongside amounts:
- `"estimated"` — computed from published pricing (most common)
- `"unknown"` — model pricing not available (custom/local models)
- `"included"` — subscription-based (Codex, etc.)

This lets the UI show `~$1.23` (estimated) vs `$0.00 (included)` vs `—` (unknown).
