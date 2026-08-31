# EP-TASK-001-bootstrap-service: Bootstrap cv-tuning

```yaml
id: EP-TASK-001-bootstrap-service
status: validated
source_task: ../11_tasks/TASK-001-bootstrap-service.md
goal_impact:
  - ../22_goal_impact/GOAL-IMPACT-TASK-001.md
validation:
  - ../12_validation/VAL-TASK-001-bootstrap-service.md
owner: project owner
created: 2026-08-30
last_updated: 2026-08-30
completeness_level: validated
parallelization_strategy: single_agent
required_gates:
  - adoption
  - pre-coding
```

## Upstream traceability

- `../../BUSINESS.md` — business intent and value proposition.
- `../../SYSTEM.md` — system responsibilities and dependencies.
- `../01_vision/VISION.md` — user need and success criteria.
- `../11_tasks/TASK-001-bootstrap-service.md` — bootstrap task record.
- `../22_goal_impact/GOAL-IMPACT-TASK-001.md` — mapped impact and measurable outcome.

## Scope

Complete the onboarding baseline for cv-tuning: project intent, governance, integration decisions, state metadata, and validation records. The document set must be consistent with the approved product concept and the runtime-service adoption profile.

## Non-goals

- Public rollout beyond the approved service boundaries.
- Unapproved external provider configuration or user onboarding.
- Rewriting the approved product intent without a human decision.

## Project invariants

- Anti-fabrication: no unsupported experience, credentials, or achievements may be introduced.
- Consent-aware access: public use remains gated until privacy and consent requirements are met.
- Traceability: every task must maintain a clear thread from intent to validation.

## Sensitive-data handling

- Keep user CV content, job descriptions, and consent status inside approved repo and service boundaries.
- Do not expose tokens, logs, or raw personal data in the repository or validation evidence.
- Use sanitized examples when necessary in validation records.

## Contract validation plan

- Validate the required integration decisions in `ips-adoption.json`.
- Confirm the required capability set is reviewed and each decision is concrete.
- Check that required integrations include contract, configuration, failure mode, and validation text.

## Replay and determinism plan

- Keep the adoption and validation documents deterministic and reviewable.
- Re-run the IPS planner after any change to the project intent or capability set.
- Maintain clear traceability for validation reports and project state.

## Files to inspect

- `BUSINESS.md`
- `SYSTEM.md`
- `docs/01_vision/VISION.md`
- `docs/00_constitution/CONSTITUTION.md`
- `ips-adoption.json`
- `STATE.json`

## Files to create

- `docs/11_tasks/TASK-001-bootstrap-service.md`
- `docs/12_validation/VAL-TASK-001-bootstrap-service.md`
- `docs/22_goal_impact/GOAL-IMPACT-TASK-001.md`
- `docs/orchestrator/VALIDATION_DEBT.md`

## Files to modify

- `README.md`
- `AGENTS.md`
- `AGENT_OPERATIONS.md`
- `TASKS.md`
- `docs/06_architecture/INTEGRATION_CONTRACT.md`
- `docs/17_governance/PROJECT_INVARIANTS.md`

## Files that must not be modified

- `docs/00_constitution/CONSTITUTION.md`
- `docs/01_vision/VISION.md`
- `BUSINESS.md`
- project-level approval and enforcement metadata without explicit owner approval

## Implementation steps

1. Fill the approved business, system, and vision context from the owner-approved product concept.
2. Complete the governance and invariants records.
3. Finalize the integration decisions in `ips-adoption.json` and the human-readable contract.
4. Verify the state metadata and required task documentation are valid.
5. Re-run the IPS planning validation and resolve any remaining blockers.

## Parallel execution

| Workstream | Status | Owner role | Allowed files | Dependencies | Validation | Merge order |
| --- | --- | --- | --- | --- | --- | --- |
| Documentation and contracts | complete | project owner | governance and contract docs | approved product concept | IPS validation | first |
| Application implementation | final integration | integration owner | repo runtime code | validated contracts | build and test | second |
| Deployment and integration | final integration | integration owner | deployment config and runtime manifests | validated application | deployment preflight | last |

## Blockers

- Final public compliance evidence for external providers remains pending authoritative approval.
- Third-party user onboarding remains blocked until consent and GDPR enforcement are complete.

## Test plan

- Validate the adoption profile structure and missing placeholders.
- Ensure required sections and statuses are present in each artifact.
- Confirm task and validation records are traceable and consistent.

## Validation plan

- Run the IPS adoption validation.
- Run the pre-coding gate.
- Validate the service with the project-level test commands.
- Record any residual validation debt in the dedicated debt file.

## Gate commands

Run from the adopting repository:

```bash
python3 ../intent-preservation-system/scripts/validate_adoption_profile.py --root . --phase planning
python3 ../intent-preservation-system/scripts/pre_coding_gate.py --root .
```

## Documentation updates

- `README.md`
- `BUSINESS.md`
- `SYSTEM.md`
- `AGENTS.md`
- `AGENT_OPERATIONS.md`
- `TASKS.md`
- `docs/06_architecture/INTEGRATION_CONTRACT.md`
- `docs/17_governance/PROJECT_INVARIANTS.md`
- `docs/11_tasks/TASK-001-bootstrap-service.md`
- `docs/12_validation/VAL-TASK-001-bootstrap-service.md`
- `docs/22_goal_impact/GOAL-IMPACT-TASK-001.md`

## Rollback plan

If a documentation change invalidates the intent baseline, revert to the last approved version and re-run the planning validation before continuing.

## Handoff

The worker should provide the updated documents, validation evidence, and any remaining blockers to the final integration owner before deployment.

## Completion checklist

- [x] Protected intent approved
- [x] Adoption profile valid
- [x] Integration decisions complete
- [x] Implementation and tests complete
- [x] Required integrations exercised
- [ ] Deployment dry run passes
- [x] Validation report complete
