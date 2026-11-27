# Pattern: Use-Case Packages

A **use-case package** is a self-contained agent capability: a plugin, a skill, a
soul, and optionally a domain engine. It is built on top of `hermes-agent-mt` and
Swarm Map consumes it as an artifact. `osint-engine` is the worked example. The
reusable scaffold is
[`usecase-package-template`](https://github.com/cyborg-garden/usecase-package-template).
Fork it to start a new one. It ships with the sanitization gate, the instance
overlay, and the contribution docs already wired.

This doc covers how Swarm Map consumes such a package, how the privacy boundaries
line up, and the **upstream contribution policy** for the base package.

## How Swarm Map consumes a package

The package separates cleanly into two halves:

- **The image:** runtime and system binaries only. Built once, pinned, rebuilt only
  when binaries change. It carries no package code.
- **The data dir** (`/opt/data`, `HERMES_HOME`): the package `git clone`, the
  operator's private skills, soul and memory, and per-engagement data. It is
  hot-mounted, so the package updates with `git pull` and a restart. No rebuild.

Swarm Map does the orchestration the operator would otherwise do by hand. It writes
the compose file, injects the package's `requires_env` keys from the encrypted env
store at runtime (never into git), manages the mount, and exposes plugin
enable/disable in the UI. When Swarm Map manages the harness, don't run
`docker compose` directly; use the Swarm Map API. The data layout is the same as
standalone use. Only the orchestrator differs.

A package's `hermes-plugin/plugin.yaml` declares `name`, `kind`, `requires_env`, and
`provides_tools`; its `register(ctx)` is called once by the plugin loader at startup.
That manifest is the contract Swarm Map installs against.

## Two privacy boundaries

A use-case package sits inside both of Swarm Map's privacy boundaries. Keep them distinct.

**Repository visibility.** The package source is private by default, optionally
per-artifact (`git:<org>/<repo>#<tag>`), and made public only by choice. When Swarm Map
installs a git-sourced artifact it runs the inbound trust gate first: pin-enforced
fetch, threat-pattern scan, and (where declared) a capability allow-list, before the
artifact reaches an agent. See `docs/specs/2026-06-03-artifact-commons-design.md` and
the [git-sourced artifacts runbook](../runbooks/git-sourced-artifacts.md).

**Cross-context visibility.** Within one running deployment, an agent serving many
contexts must not leak skills, working files, or memory across them. Structured memory
is already scoped via `MemoryStore(context_id=)`; the working filesystem and skills are
governed by the glocal read floor. Per the
[image/Swarm Map boundary](../architecture/image-vs-hsm-boundary.md), the enforcement
layers live in the `hermes-agent-mt` image: L1 in-process read-deny and L2 terminal
command-guard, both defense-in-depth. The only true boundary is L3: secrets are not
mounted into the agent namespace, and Swarm Map's compose owns that. Do not present
L1/L2 as walls.

## Upstream contribution policy (read before accepting base-package PRs)

The base package ships to **every** deployed agent. An injected line therefore carries
fleet-wide blast radius. The policy that keeps the commons trustworthy as it opens:

**Inbound contributions to the base are proposals, not merges.** A contributor opens a
PR describing a generic capability and providing the generalized artifact as a reference.
The sanitization gate runs on the diff (deterministic secrets/PII + semantic particulars).
Maintainers do **not** merge the submitted bytes. They **close the PR and re-author**
the capability from the described pattern, against trusted code. The contributor gets
credit and the capability lands; their exact bytes do not enter the base.

This is the supply-chain defense for the commons. The gate makes *sharing* safe; the
rewrite makes *accepting* safe. The gate's semantic layer runs only on trusted branches
until `pull_request_target` trusted-scanner hardening is in place, so that an injected
PR cannot steal the build-time key. That is another reason inbound code is never
trusted as-is.

Promotion to an operator's *own* package is different: that is autonomous, gated by the
same sanitization check, and merged at the operator's discretion. Only the **base**, the
shared substrate, carries the close-and-rewrite rule.
