# Runbook: git-sourced artifacts (the trust gate in practice)

How a plugin, skill or hook goes from a private repo to a live agent, safely.
Companion to [the artifact commons spec](../specs/2026-06-03-artifact-commons-design.md) and
[the image vs Swarm Map boundary](../architecture/image-vs-hsm-boundary.md).

## 1. Build the artifact in its own (private) repo
- **One repo per artifact** (or one for a tightly-paired plugin+skill). Start **private**.
- Layout (standard artifact convention): `hermes-plugin/` (`plugin.yaml` + `__init__.py`
  + code), `hermes-skill/SKILL.md`, `tests/`.
- `plugin.yaml` declares `declared_capabilities` (e.g. `tools: []`, `network: true`).
- Add GitHub collaborators to the private repo to collaborate **before** it's public.

## 2. Tag it: pinning is mandatory
```sh
git tag v0.1.0 && git push origin v0.1.0
```
The manifest references a **tag**, never a branch. `parseGitSource` rejects an
unpinned source loudly, because an unpinned ref can silently drift to malicious code.

## 3. Reference it in the manifest
`infra/artifacts.json`. **Point the source at the artifact *subdir* inside the
repo** (`#<tag>:<subdir>`), never the repo root. A single repo usually holds a
plugin **and** a skill side by side (the standard layout). Each is referenced by its
own subdir and installed to its own agent dir (`plugins/<name>/`, `skills/<name>/`):
```json
{
  "plugins": [
    { "name": "example_plugin",   "source": "git:<org>/<repo>#v0.1.0:hermes-plugin", "enabled": true }
  ],
  "skills": [
    { "name": "example-skill", "source": "git:<org>/<repo>#v0.1.0:hermes-skill" }
  ]
}
```
Without a subdir the whole repo root (README, `tests/`, both `hermes-*` dirs) is
copied into `plugins/<name>/` and the runtime won't find `plugin.yaml`.

## 4. Provision the build-time token (Swarm Map server env)
- Set `ARTIFACT_GIT_TOKEN` (falls back to `GITHUB_TOKEN`) on the **Swarm Map server**.
  It is deliberately separate from the per-agent runtime `GITHUB_TOKEN`. The agent never
  sees it.
- It MUST be a token with **`contents:read`** on the artifact repos: a **classic
  PAT with `repo`**, or a **fine-grained PAT** scoped to the artifact repos.
  > A `gh`-CLI `ghu_` OAuth/App token may **not** have repo-contents access. A
  > clone then returns `remote: Write access to repository not granted.` Use a PAT.
- The token reaches git through `GIT_ASKPASS` with an `x-access-token` username.
  It is **never** in the clone URL or argv (see Security notes).

## 5. What Swarm Map does on agent create
`installBaselineTemplates` → `installArtifacts`:
```
parse (pin-enforced) → shallow clone at the tag → content trust gate
(injection / promptware scan) → REFUSE on a finding, else install
```
The image-side enforcement (per-plugin `declared_capabilities` dispatch gate +
fail-closed plugin-skill scan) is the **runtime backstop**, as defense in depth.

## 6. Going public
Flip the artifact repo's visibility **private → public**. Nothing else changes.
The `git:<org>/<repo>#<tag>` reference stays the same and history is preserved.

## Security notes
- **Never put the token in the clone URL or argv.** It leaks via `ps` and via
  clone error messages. Use `GIT_ASKPASS` (token in the child env, not on disk in
  plaintext) + the `x-access-token` username. Errors are redacted (`redactSecrets`)
  as defense in depth. (Learned the hard way: an early version embedded the token
  in the URL and a failed clone printed it. Rotate any token exposed this way.)
- **Keep the TypeScript threat-pattern scanner** (`lib/services/threat-patterns.ts`) **in sync** with the image-side
  Python library (`tools/threat_patterns.py`) when patterns change.
- A git-sourced artifact crossing into the commons is the cross-trust-boundary
  case: this is where `declared_capabilities` should become **mandatory** (vs
  opt-in for trusted local plugins).
