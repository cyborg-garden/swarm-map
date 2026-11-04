---
name: engineering-process
description: Read before changing code, opening a PR, or saying done. How a change reaches a repo in this org, from branch to merge.
---

# Engineering process

This pack is process only. It grants no access: no token, no repo, no tool. If you lack access, say so. Do not look for another credential to get round it.

Memory repos and notes that have their own commit flow keep it. This is for code.

## Start
- Work on a new branch in your own worktree, off the repo's integration branch. It is usually `main`, but some repos use `develop`, so check.
- From the repo root: `git fetch origin && git worktree add --no-track ../<repo>-<slug> -b <branch> origin/<base>`
- Push with `git push -u origin <branch>`. Never push to the integration branch. All changes go through a PR.
- Remove your worktree once the PR is merged or closed.

## Test
- Find the test commands CI runs (`.github/workflows`, the README) and run those yourself, before you ask for a merge. Do not run deploy, release or publish steps.
- A failing test blocks the merge, even if your branch did not cause it. Fix it, or report that you are blocked. Never offer a merge past a red test.
- A new test that passes on its first run proves nothing. Break the code, watch the test fail, then restore the code.
- Never say done, fixed or working unless you ran it. Say what you ran and what it showed. If you could not run it, say `Not verified` and why.

## Commit and PR
- Commit subject: `type(scope): imperative summary`, lowercase, for example `fix(gateway): stop dropping thread replies`.
- PR body, never empty:
  - `## What`: 1 to 4 bullets.
  - `## Why`: 1 to 3 sentences.
  - `## Verification`: what you ran and the result, or `Not verified` and why.

## Audit, then merge
1. Get an independent audit: a fresh reviewer, such as `delegate_task`, given the diff and the goal but not your conclusions.
2. Fix what it finds.
3. Audit again with a fresh reviewer. Fixes bring new defects, so repeat until a round comes back clean.
4. Report the audit rounds and results, and give the owner a short merge command they can copy, such as `gh pr merge 123 -R org/repo --squash`.

Do not merge it yourself unless the owner told you to merge that PR and your deployment gives you a real check that it was them (see `engineering-multiplayer`).

## What is not proof
- "Cleanly merged" means no text conflict. A cherry-pick or auto-merge can land the fix as dead code beside the buggy call path. Search for the symbols and read the path that actually runs.
- Squash merges hide landed work: `git branch --merged` and `git log origin/<base>..<branch>` will say it never landed. Compare file contents against `origin/<base>` before you redo or discard a branch.
- "CI green" means the checks it ran passed. Check that they cover your change, and that what is deployed actually contains it.
