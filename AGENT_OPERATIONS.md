# Agent Operations: cv-tuning

This repository follows the company Cross-Agent Automation Standard:

```text
/home/ssf/.ai-agent-standards/CROSS_AGENT_AUTOMATION_STANDARD.md
```

## Roles

- Readiness scanner: classify work and blockers without implementing.
- Worker agent: implement one bounded task or workstream.
- Worker monitor: track task handoff and shared-file conflicts.
- Integration validator: confirm completed work and separate regressions from recorded validation debt.

## Before work

Confirm that:

- an active task and upstream traceability exist;
- an execution plan defines scope, allowed files, and forbidden files;
- integration and invariant impacts are explicit;
- sensitive-data and contract/schema impacts are classified;
- validation commands and evidence paths are named;
- parallel ownership and merge order are clear.

## Parallel work

Do not assign multiple agents to the same file, schema, migration, public contract, deployment file, or status artifact without one documented integration owner and conflict-resolution order.

## Validation debt

Record known out-of-scope failures in `docs/orchestrator/VALIDATION_DEBT.md`. Validation debt never excuses a failure that affects the active task or changed files.

## Handoff

Update `TASKS.md` and `STATE.json` before ending an incomplete session. Record deferred deployment explicitly.

## Project-specific operations

- Keep the anti-fabrication and provenance model intact across prompt, generation, and rendering changes.
- When editing user-facing CV language, preserve the evidence chain to the source facts.
- Run the smallest relevant validation before broader repository-level checks.
- Maintain the consent and GDPR gates before broader user access.
