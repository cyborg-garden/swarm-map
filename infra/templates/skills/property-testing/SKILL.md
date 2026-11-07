---
name: property-testing
description: Read before testing tricky stateful code or a validator. Generate many random cases, compare with a simple model, and prove the test can fail.
---

# Property testing

This skill is process only. It grants no access: no token, no repo, no tool.

Adapted from `proptest-praxis` by Inanna Malick (github.com/inanna-malick/agent-skills). Copyright (c) 2026 Inanna Malick, MIT licence, see github.com/inanna-malick/agent-skills/blob/main/LICENSE.

## When it pays
- Code that is hard inside but easy to describe: caches, indexes, queues, state machines, parsers, merges, config loaders.
- Validators and gates, anything whose job is to say yes or no.
- Skip it for glue code with nothing to check.

## The core loop
1. Write a dumb model, such as a list, a dict or a full recompute. It must not reuse the real code's helpers, or both can be wrong the same way.
2. Generate random sequences of operations (add, remove, read, clear, retry, fail) and run each on the real code and the model.
3. Compare after every step. Let the library shrink a failure to its smallest case.
- Python: `hypothesis` `RuleBasedStateMachine` with `@rule` and `@invariant`, a `Bundle` to feed earlier keys back in, and `TestX = Machine.TestCase`.
- TypeScript: `fc.assert(fc.property(fc.commands([...]), cmds => fc.modelRun(setup, cmds)))` with `fast-check`.
- Rust: `proptest` with a `Vec<Op>` strategy, or `proptest-state-machine`.
- All randomness comes from the generator, never `random()` in the test body, or shrinking and replay break. Build related inputs (map, flatMap, composite) instead of filtering most cases away.

## Make the generator find things
- Use small value pools, so keys repeat, collide and get overwritten.
- Mix in patterns: remove then re-add, fill then clear then refill, fail on call k then keep going, read before and after a change.
- Look at what it actually generates. Mostly empty or no-op cases means it is blind, and more runs will not fix that.
- Build valid inputs, then break one thing at a time (a missing field, a bad length, a duplicate id). Keep fully random junk tests too.

## Validators and gates
- Known-good inputs must pass.
- Take a good input and plant one known-bad thing, in different spots and wrappings. It must be caught.

## Parsers and serializers
- Encode then decode must give back the original. Where the format normalises, compare meaning, not bytes.
- Feed truncated, malformed and boundary-sized input separately, looking for crashes and wrong acceptance.

## Prove the test can fail
A quiet run is not proof. Before trusting the suite, break the code on purpose (skip a cache clear, drop an index update, let one bad pattern through). The suite must go red. If it stays green, fix the generator or the check, not the code. Restore the code after.

## When it finds a bug
- Reproduce it. Check the model and the test glue too, since the bug may be in the test.
- Turn the smallest case into a plain, fixed unit test. Watch it fail on the current code.
- One PR per bug, holding that test and the smallest fix. Keep the big random suite apart unless the repo wants it.
- Look for the same bug in nearby, similar code.
- If it could be a security hole, tell the owner privately. No public issue, PR or branch until they clear it.

## Report
Say what you tested, how many cases ran, which planted bugs it caught, and what it cannot see. Never call code safe because a run was quiet.
