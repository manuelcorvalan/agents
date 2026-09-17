# ADR-0001: Record architecture decisions

- **Status:** accepted
- **Date:** 2026-09-17
- **Deciders:** Architect
- **Related:** `docs/adr/README.md`, `docs/adr/template.md`, `agents/architect.md`

## Context

The team (PM, PO, Backend, Frontend, Database, QA, DevOps, Security, Data Analyst,
Web Design, Reporting) makes many technical decisions across a project's lifetime.
Decisions were being communicated only through chat, code, or the PM's summaries.
As a result:

- The rationale behind choices was lost, so decisions were re-litigated.
- New agents and contributors could not tell why the system was built a certain way.
- Cross-cutting changes (stack, API contracts, data model) had no durable record,
  increasing the risk of inconsistent implementations between Backend and Frontend.

`STANDARDS.md` already references ADRs as the mechanism for imposing new
conventions, but no structure existed to hold them.

## Decision

We will record architecture decisions as **Architecture Decision Records (ADRs)**.

- ADRs live in `docs/adr/`, one decision per file, named `NNNN-<kebab-slug>.md`.
- The **Architect** agent owns writing and maintaining ADRs.
- The format is defined by `docs/adr/template.md`: title, status, context,
  decision, consequences, and alternatives considered.
- Any decision that is significant, cross-cutting, and costly to reverse requires
  an ADR; accepted ADRs are binding until superseded by a newer ADR.
- Accepted ADRs are never rewritten in meaning — a new ADR supersedes them.

## Consequences

**Positive**
- Decisions have a durable, reviewable rationale.
- The team stops re-litigating settled questions.
- Onboarding and cross-agent collaboration improve: contracts and constraints are explicit.
- Security, QA, and DevOps gain a reference for why controls exist.

**Negative**
- Small process overhead: writing an ADR takes time and discipline.
- Risk of stale ADRs if they are not updated when superseded.

**Follow-ups**
- Link ADRs from code and `docs/kb/` where relevant.
- The Architect reviews the ADR index periodically and marks outdated entries.

## Alternatives considered

- **Chat-only decisions** — zero overhead, but rationale is lost and decisions get
  re-litigated; rejected because it does not scale across agents or time.
- **A single `ARCHITECTURE.md` document** — easier to find, but becomes a merge
  battleground, loses decision history, and has no per-decision status; rejected.
- **Design docs per feature** — richer than ADRs, but heavier and not focused on
  decisions; rejected as the primary record, though still used for large designs.
