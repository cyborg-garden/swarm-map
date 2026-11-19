# Contributing to Swarm Map

Thanks for your interest in contributing. This guide covers setup, project structure, and how to get a PR merged.

---

## Development Setup

### Prerequisites

- **Node.js 20.9 or newer** (Next.js 16 needs it). Door agent work needs 22.18 or newer.
- **pnpm**
- **Docker**, if you want to run agents. The tests don't need it.
- **Python 3**, to run the sanitization gate locally.

### Install and run

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
pnpm install
pnpm seed    # first run only
pnpm dev
```

The app runs at `http://localhost:3000`, or the next free port up to 3010.

### Run tests

```bash
pnpm vitest run
```

Tests use [Vitest](https://vitest.dev/) with `jsdom` and `@testing-library/react`. They mock Docker and the filesystem, so no real containers are needed.

The runtime conformance suite has its own scripts: `pnpm conformance`, and `pnpm conformance:docker` for the version that runs each harness in a sealed Docker cell. Build its images first with `pnpm conformance:docker:build`.

---

## Project Structure

```
swarm-map/
├── app/                    # Next.js App Router
│   ├── (dashboard)/            # Dashboard pages (agent list, detail views)
│   ├── (setup)/                # Setup wizard flow
│   ├── api/                    # API route handlers
│   ├── layout.tsx              # Root layout
│   └── globals.css             # Global styles (Tailwind)
│
├── components/             # React components
│   ├── harness/                # Agent harness management UI
│   ├── shared/                 # Reusable components (modals, forms)
│   ├── shell/                  # App shell (sidebar, header)
│   ├── surfaces/               # Surface configuration (Telegram, Signal, etc.)
│   ├── fleet/                  # Fleet table and status
│   ├── ui/                     # Primitives (buttons, inputs, cards)
│   └── wizard/                 # Setup wizard steps
│
├── lib/                    # Core logic
│   ├── services/               # Backend services (docker, config, encryption, etc.)
│   ├── surfaces/               # Per-surface permission registry
│   ├── core/                   # Door agents: the rule engine (decide)
│   ├── door/                   # Door agents: the guard process
│   ├── runtimes/               # Door agents: harness shims (pi, letta-code, claude-sdk)
│   ├── hooks/                  # React hooks
│   ├── __tests__/              # Unit tests
│   ├── types.ts                # Shared TypeScript types
│   ├── constants.ts            # App constants
│   └── utils.ts                # Utility functions
│
├── conformance/            # Harness-neutral runtime conformance suite
├── infra/                  # Agent templates, base package, signal-cli
├── scripts/                # Sanitization gate, token broker, helpers
└── bin/                    # Dev scripts
```

---

## Code Style

- **TypeScript** throughout. No `any` unless unavoidable.
- **Tailwind CSS** for styling. Use `cn()` (from `lib/utils.ts`) for conditional classes.
- **Server Components by default.** Only add `"use client"` when you need interactivity or browser APIs.
- Keep components focused. If a file grows past ~200 lines, extract subcomponents.

---

## Pull Request Process

### Branch naming

Branch from `main`. Use descriptive names:

```
fix/restart-race-condition
feat/group-policy-ui
docs/setup-instructions
```

### Before submitting

1. Run tests: `pnpm vitest run`
2. Run the linter: `pnpm lint`
3. Test manually in the browser. Check that the UI flow you changed works end to end.
4. Run the sanitization gate on what you changed: `python scripts/check_sanitization.py --deterministic-only <files>`. CI runs both layers on every PR. See [the sanitization gate](docs/sanitization-gate.md).
5. Keep PRs focused: one logical change per PR.

### PR description

Include:
- **What** changed and **why**
- **How to test** (steps to exercise the change in the UI)
- Screenshots if the change is visual

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(surfaces): add Signal group policy editor
fix(docker): handle restart timeout on slow containers
chore: bump dependencies
```

---

## Reporting Issues

Use [GitHub Issues](https://github.com/cyborg-garden/swarm-map/issues). Include:
- Browser and OS
- Steps to reproduce
- Expected vs. actual behavior
- Console errors or screenshots if applicable

---

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).
