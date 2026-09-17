# Knowledge Base (KB)

The Knowledge Base holds **reusable knowledge** produced while building: lessons
learned and patterns that the team should repeat or avoid. It complements ADRs —
an ADR records a *decision*, the KB records *experience*.

- **Audience:** all agents (PM, PO, Backend, Frontend, Database, QA, DevOps, Security, Data Analyst, Web Design, Reporting).
- **Related:** `docs/adr/` for decisions, `STANDARDS.md` for quality gates.

## What belongs here
- **Lessons learned** — what worked, what failed, and why. Include the symptom,
  the root cause, and the fix or prevention.
- **Patterns** — reusable solutions to recurring problems, with when to use and
  when *not* to use them.
- **Pitfalls** — traps to avoid, with a concrete example.
- **Recipes** — short, copy-pasteable procedures for common tasks.

What does **not** belong here: decisions (use an ADR), project-specific
documentation (use the project's own docs), or anything already covered by
`STANDARDS.md` (link to it instead of duplicating).

## Structure
```
docs/kb/
├── README.md            # this file — index and conventions
├── lessons-learned.md   # created when the first lesson is recorded
└── patterns.md          # created when the first pattern is recorded
```
Start by adding entries here, then split into `lessons-learned.md` /
`patterns.md` once there is content — and split further as the KB grows
(e.g. `patterns/api-versioning.md`).

## Conventions
- **One entry per topic**, with a short descriptive title.
- Every entry states the **context**, the **problem**, the **solution**, and the
  **takeaway** in one or two sentences.
- Link the source: PR, issue, ADR, or story id.
- Date entries and note the author/agent.
- Keep it terse and actionable — no essays.

## Entry format

### <Short title>
- **Context:** when/where this applies.
- **Problem:** what goes wrong (symptom → root cause).
- **Solution:** what to do instead.
- **Takeaway:** the one-line rule to remember.
- **Source:** <PR / issue / ADR / story>

## Contributing
1. Add the entry to `lessons-learned.md` or `patterns.md` (or a new file).
2. Link it from this README's index if you created a new file.
3. If the entry implies a binding rule, propose an ADR instead of burying it here.

## Index
No entries yet. When files are created, list them here:

| File | Contents |
|------|----------|
| _(none yet)_ | Add `lessons-learned.md` / `patterns.md` when the first entry is recorded |
