# Specifications

Version-controlled copies of the Athoor Loyalty Platform specification, so the
requirements, design and implementation plan evolve and are reviewed alongside
the service code rather than living only on one machine.

## Contents

`athoor-loyalty-platform/`

| File | What it holds |
|---|---|
| `requirements.md` | Numbered acceptance criteria in EARS form (the `Req X.Y` references cited throughout the code comments) |
| `design.md` | Architecture, data model, component contracts, and the correctness properties (Properties 1–17) the property-based tests validate |
| `tasks.md` | Implementation plan. Tasks 1–22 are the delivered release candidate; Phase 5 (tasks 23–28) is the post-staging backlog |

## Relationship to `~/.kiro/specs/`

Kiro's spec tooling reads and writes `~/.kiro/specs/athoor-loyalty-platform/`,
which is outside this repository. That remains the working location; the copies
here are the reviewable, version-controlled record.

Because they are copies rather than symlinks, they can drift. **When a spec
changes, re-sync before committing:**

```bash
cp ~/.kiro/specs/athoor-loyalty-platform/*.md docs/specs/athoor-loyalty-platform/
```

To check whether the two have diverged:

```bash
diff -r ~/.kiro/specs/athoor-loyalty-platform docs/specs/athoor-loyalty-platform
```

## Traceability

Code comments and test names cite requirement clauses (`Req 3.9`) and properties
(`Property 17`) that resolve to these documents, so a reviewer can trace any
behaviour back to the clause that mandates it. Keeping the specs in the repo
means a change that alters behaviour and the clause justifying it can be
reviewed as one unit.
