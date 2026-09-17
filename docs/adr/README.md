# Architecture Decision Records (ADR)

An **Architecture Decision Record (ADR)** captures a single significant technical decision: the context, the choice made, and its consequences. ADRs are the durable memory of the project — they explain *why* the system is the way it is, not just *what* it is.

- **Owner:** Architect agent (`agents/architect.md`) — writes and maintains ADRs.
- **Audience:** the whole team (PM, Backend, Frontend, Database, QA, DevOps, Security).

## What an ADR is
- A short, dated, immutable-in-intent document describing one decision.
- A record of trade-offs: what we chose, what we rejected, and why.
- A binding reference: once `accepted`, the team follows it until a later ADR supersedes it.

An ADR is **not** a design doc, a spec, or a tutorial. Keep it focused on the decision.

## When to create an ADR
Create one for any decision that is **significant, cross-cutting, and costly to reverse**, such as:

- Choosing or changing the stack, framework, or database.
- Defining or changing **API contracts** and module boundaries.
- Changing the **data model** in a way that affects other modules.
- Introducing a new integration, third-party service, or infrastructure component.
- Adopting a new convention that overrides `STANDARDS.md`.
- Accepting a known trade-off or a deliberate piece of technical debt.

If the decision is local, cheap to reverse, and confined to one module — skip the ADR and leave a code comment.

## Lifecycle
| Status | Meaning |
|--------|---------|
| `proposed` | Written, under discussion, not yet binding. |
| `accepted` | Approved and binding for the team. |
| `rejected` | Considered and declined (kept for context). |
| `deprecated` | Still in effect but no longer recommended. |
| `superseded by ADR-NNNN` | Replaced by a newer decision. |

## How to write one
1. Copy `template.md` to `NNNN-<kebab-slug>.md` (next sequential number).
2. Fill in context, decision, consequences, and alternatives.
3. Set status to `proposed`; the Architect moves it to `accepted` after review.
4. Reference the ADR from the code and from `docs/kb/` where relevant.

## Conventions
- **Filename:** `NNNN-<kebab-slug>.md` — e.g. `0002-use-postgresql.md`.
- **Numbering:** strictly sequential, zero-padded to 4 digits, never reused.
- **Superseding:** never edit an accepted decision's meaning — write a new ADR that supersedes it and update the old one's status.
- **Immutability:** typos/clarifications are fine; changing the decision is not.

## Index
| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | accepted |
