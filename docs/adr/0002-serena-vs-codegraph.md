# ADR-0002: Serena vs CodeGraph for semantic code intelligence

- **Status:** proposed
- **Date:** 2026-09-17
- **Deciders:** Architect
- **Related:** [oraios/serena](https://github.com/oraios/serena), [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph), `agents/architect.md`, `agents/backend.md`, `agents/frontend.md`, `opencode.json`

## Context

The technical agents (Backend, Frontend, QA, Architect, Database, Data Analyst,
Security) already use **CodeGraph** as their code-intelligence layer. CodeGraph
builds a pre-indexed knowledge graph of a project and exposes a single
`codegraph_explore` tool that returns verbatim source, call paths (including
dynamic-dispatch hops), and blast radius in one call. It is wired globally and
gated per agent via `permission.codegraph_*` in `opencode.json`.

Two forces make it worth evaluating a second, semantic tool:

1. **Token budget.** Models run at a 64k context. Every exploration call that
   CodeGraph does not answer becomes a grep/read loop that burns context.
2. **Editing/refactoring.** CodeGraph is read-oriented: it answers "where is X,
   what calls it, what does this change affect". It does not perform
   symbol-level edits, cross-file renames, or moves.

[Serena](https://github.com/oraios/serena) is an MCP toolkit that adds
LSP/JetBrains-backed **semantic retrieval *and* editing**: find symbol,
references, type hierarchy, rename, move, inline, replace-symbol-body, plus a
memory system. It overlaps CodeGraph on retrieval but adds atomic refactoring.

The question: should we adopt Serena, keep CodeGraph, or run both?

## Decision

**Keep CodeGraph as the single code-intelligence layer for now. Do not install
Serena yet.** Re-evaluate if/when the team hits recurring, symbol-level
refactoring work that CodeGraph cannot do.

This is a **proposed** ADR — it records the evaluation and a provisional
recommendation; the Architect moves it to `accepted` or `rejected` after a
trial if the need materializes.

Rationale:

- **Overlap cost.** Both index the codebase and expose retrieval tools. Running
  both doubles the fixed tool-schema context and creates two sources of truth
  for "where is X". At 64k context this is a real tax.
- **CodeGraph is already wired and paid for.** Global install, per-agent
  permissions, and agent instructions are in place; Serena would add an
  install (`uv tool install serena-agent`), a new backend (LSP servers per
  language), and new config.
- **No demonstrated editing gap yet.** No current workflow is blocked by the
  absence of symbol-level rename/move. If one appears, the gap is narrow and
  localized, which is exactly when Serena earns its keep.

## Consequences

**Positive**
- One code-intelligence layer: one tool schema, one mental model, no ambiguity
  about which tool to call.
- No new install surface, no LSP-per-language setup, no extra context cost.
- Context budget preserved for the existing five token layers (caveman, RTK,
  CodeGraph, Context7, Repomix).

**Negative**
- No symbol-level refactoring: cross-file renames and moves remain manual
  search/replace, which is error-prone and token-expensive on large codebases.
- If the codebase grows into a multi-language monorepo, CodeGraph's
  best-effort name matching may be less precise than an LSP-backed tool.

**Follow-ups**
- Re-open this ADR if any of these triggers occur: (a) a cross-file rename/move
  task touching >5 files, (b) repeated grep/read loops CodeGraph fails to
  collapse, (c) adoption of a large multi-language monorepo.
- If adopted later, prefer running Serena **alongside** CodeGraph with disjoint
  responsibilities: Serena for editing/refactoring, CodeGraph for exploration
  and blast radius. Do not run both for the same retrieval task.

## Alternatives considered

- **Adopt Serena, replace CodeGraph** — Serena adds editing on top of
  retrieval, so it is a superset in capability; rejected because it discards an
  already-wired, working tool and adds per-language LSP setup, for a capability
  (refactoring) not yet required.
- **Run both now** — maximum capability; rejected because it doubles the
  tool-schema context and creates two retrieval sources of truth before any
  demonstrated need.
- **Adopt Serena for editing only, keep CodeGraph for retrieval** — the
  recommended shape *if and when* the need arises; deferred because the need is
  not yet proven.
