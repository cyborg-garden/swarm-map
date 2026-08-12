# Contributing to Swarm Map

Thanks for your interest in contributing. This guide covers setup, project structure, and how to get a PR merged.

---

## Development Setup

### Prerequisites

- **Node.js 18+**
- **npm** (ships with Node)

### Install and run

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
npm install
npm run dev
```

The app runs at `http://localhost:3000`.

### Run tests

```bash
npx vitest run
```

Tests use [Vitest](https://vitest.dev/) with `happy-dom` and `@testing-library/react`.

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
│   ├── ui/                     # Primitives (buttons, inputs, cards)
│   └── wizard/                 # Setup wizard steps
│
├── lib/                    # Core logic
│   ├── services/               # Backend services (docker, config, encryption, etc.)
│   ├── hooks/                  # React hooks
│   ├── __tests__/              # Unit tests
│   ├── types.ts                # Shared TypeScript types
│   ├── constants.ts            # App constants
│   └── utils.ts                # Utility functions
│
└── bin/                    # Dev scripts
```

---

## Code Style

- **TypeScript** throughout — no `any` unless unavoidable.
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

1. Run tests: `npx vitest run`
2. Run the linter: `npm run lint`
3. Test manually in the browser — verify the UI flow you changed works end-to-end.
4. Keep PRs focused: one logical change per PR.

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
