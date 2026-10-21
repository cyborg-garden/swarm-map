# Claude Code — Swarm Map

See **AGENTS.md** for architecture, patterns, service layer, and what not to do. Read it before touching any code.

---

## Session Rules

1. **Read AGENTS.md first.** Every session. It has the architecture decisions, key patterns, and "what not to do" rules. Some behaviors (port allocation, encryption, compose rules) are non-obvious.

2. **Run tests before committing.**
   ```bash
   pnpm vitest run
   ```
   All tests must pass. Don't skip or comment out tests.

3. **Standard git workflow.** No shared-memory conventions here: no `memory/` dir, no `/save`, `/handoff` or `/wrap` commands.

4. **Next.js version warning.** This runs Next.js 16 — params are Promises, layouts support `export const dynamic`, etc. Check `node_modules/next/dist/docs/` when unsure.

5. **No secrets in commits.** API keys, tokens, `.env` files are gitignored.

## Quick Reference

```bash
pnpm dev          # smart port detection via bin/dev.sh
pnpm build        # production build
pnpm vitest run   # all tests
pnpm seed         # re-seed settings + tier config
```

## Key Files

- `docs/architecture/image-vs-hsm-boundary.md` — decision framework: what goes in the Docker image vs HSM
- `lib/services/harness.ts` — agent discovery, create/import/duplicate, lifecycle
- `lib/services/docker.ts` — Docker CLI wrapper (stats, restart, pull, health check)
- `lib/services/keys.ts` — key discovery from .env files + encryption
- `lib/types.ts` — all shared TypeScript types
- `app/api/setup/deploy/route.ts` — full agent deploy pipeline
- `app/(dashboard)/harnesses/[id]/page.tsx` — harness detail page (tabbed, largest component)
- `app/(setup)/setup/wizard/page.tsx` — 5-step creation wizard

## API-First

The REST API at `/api/*` supports full programmatic control. Any AI agent (Claude Code, Hermes, scripts) can orchestrate the fleet without the GUI. See README.md for the full endpoint table.
