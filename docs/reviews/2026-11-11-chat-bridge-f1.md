# Review: Team Chat Bridge F1 (integrations/chat)

```
REVIEW RECEIPT
Diff: feature/chat-bridge working tree vs HEAD e28b731 (uncommitted: integrations/chat/**, .claude/settings.json, .env.example, .gitignore, .github/workflows/ci.yml, docs/adr/0003-chat-bridge.md, schema fixtures)
Reviewer: cavecrew-reviewer
Findings: 🔴 0 | 🟡 9 | 🟢 0
Veredicto: APPROVED
Fecha: 2026-11-11
```

Contract: ADR-0003 D1–D16 + Amendments A1–A7. Local DoD evidence: `npm test` 593/593 pass, coverage 99.42% lines / 97.13% branches; `npm run lint` clean (Node 26.12.0).
Additional: 1 ❓ question (not a severity tier in STANDARDS §4; does not block).

## Findings

```
integrations/chat/schema/event.v1.schema.json:163: ❓ question: outcome enum is success|error|unknown, ADR A4 says "failure is reserved". Which name is the contract? Align ADR or schema (enum change = tightening, v2 rule).
integrations/chat/src/adapters/slack.mjs:43: 🟡 risk: section block mrkdwn text limit is 3000 chars; escapeMrkdwn expands &<> up to 5x, so max_summary_chars up to 2000 can render >3000 -> invalid_blocks -> dead-letter. Cap escaped block text (truncate after escape) or bound max_summary_chars so escaped length fits.
integrations/chat/src/adapters/slack.mjs:91: 🟡 risk: 2xx with unparseable body marked retryable. Slack likely posted; retry duplicates message. Treat 2xx invalid_response as non-retryable.
integrations/chat/src/app/emit.mjs:98: 🟡 risk: D15 forbids hook stdin cwd as .env source, but projectDir falls back to payload.cwd and is passed as CHAT_BRIDGE_PROJECT_DIR (L73) so the sender loads .env (incl. SLACK_BOT_TOKEN) from the stdin cwd when CLAUDE_PROJECT_DIR is unset. Do not fall back to payload.cwd; when CLAUDE_PROJECT_DIR is missing, skip CHAT_BRIDGE_PROJECT_DIR (sender loads nothing).
integrations/chat/src/app/emit.mjs:145: 🟡 risk: lost wakeup. Sender decides idle-exit (sender.mjs:206) while still holding lock; emitter appends, sees live lock, skips spawn; sender exits -> event stuck until next hook (often next session). After release(), sender should re-check outbox size > cursor and re-loop/respawn.
integrations/chat/src/app/sender.mjs:208: 🟡 risk: rotation race loses events. Emitter that opened outbox before rename appends to the .draining file after the second drain; removeFile deletes it unread. Rotate only when no writer can hold old inode (e.g. drain rotated file until stable size across a delay > hook deadline) or keep the rotated file until a later sender drains it.
integrations/chat/src/bus/ledger.mjs:6: 🟡 risk: ledger never pruned and read via readSafe 50 MB head cap; past cap the newest entries are unread -> already-sent events re-posted, and full load on every sender start. Prune/compact ledger (e.g. TTL) or read tail.
integrations/chat/src/bus/lock.mjs:76: 🟡 risk: stale-lock takeover race. Two senders both see stale lock; A removes+creates, B then removes A's fresh lock and creates its own -> two concurrent drains with separate in-memory ledgers -> duplicate posts, cursor clobber. Re-read lock after create and compare pid/started_at, or take over via rename/link of a unique tmp file.
integrations/chat/src/config/load-config.mjs:21: 🟡 risk: A1 requires every cavecrew-* agent in agents/ (cavecrew-builder, cavecrew-investigator) in roles; REQUIRED_ROLES and schema/identities.v1.schema.json:114 only require cavecrew-reviewer. Add both to validator + schema (parity test).
integrations/chat/src/config/load-config.mjs:229: 🟡 risk: D15 says relative CHAT_BRIDGE_CONFIG resolves against projectDir; a process-env value (wins over .env, not validated) is resolve()d against cwd. Hook cwd != sender cwd (projectDir) -> emitter and sender can load different configs. Resolve against projectDir in loadBridgeConfig.
integrations/chat/src/core/redact.mjs:20: 🟡 risk: redaction can be bypassed with invisible chars not in the strip set. Verified: "xox­b-1234567890-abcdefghijkl" (soft hyphen) passes unmasked and renders as a readable token in Slack. Add U+00AD, U+034F, U+061C, U+115F/1160, U+17B4/17B5, U+180E, U+3164, U+FE00-FE0F (outside emoji ZWJ use), U+FFA0 to CONTROL_AND_BIDI (stricter = allowed per A6) + corpus case.
totals: 0🔴 9🟡 1❓
```

## Notes
- Hook contract (zero stdout, exit 0, fast path, `timeout: 2`), token handling (env only, Bearer header only, error codes only in logs), network allowlist, `link_names/unfurl_*: false`, mrkdwn `&<>` escaping, D16 gitignore of `config/config.json`, and CI `chat-bridge` job (Node 24, coverage 80/80, audit) checked against ADR; no deviations beyond the findings above.
- 🟡 findings must be logged as issues per STANDARDS §4. Merge not blocked.

---

## Re-review (after Backend fixes for review 🟡×9 + Security M1/M2/M3/L2/L3)

```
REVIEW RECEIPT
Diff: feature/chat-bridge working tree vs HEAD e28b731 (uncommitted), delta since first review: src/adapters/slack.mjs, src/app/emit.mjs, src/app/sender.mjs, src/bus/{ledger,lock,safe-fs}.mjs, src/config/load-config.mjs, src/core/{redact,map-claude-hook,format-text}.mjs, schema/identities.v1.schema.json, test/app/review-fixes.test.mjs (new), test/acceptance/us-005-emitter.test.mjs, test/adapters/slack.test.mjs, test/core/map-claude-hook.test.mjs
Reviewer: cavecrew-reviewer
Findings: 🔴 1 | 🟡 3 | 🟢 0
Veredicto: CHANGES REQUESTED
Fecha: 2026-11-11
```

Additional: 1 ❓ question (non-blocking). Local: `npm test` 647/647 pass, coverage 99.47% lines / 96.97% branches; lint clean.

### Original findings: status
| # | Finding | Status |
|---|---|---|
| 1 | slack.mjs:43 block >3000 after escape | resolved (`escapeAndCap`, caps escaped length, no entity/surrogate split) |
| 2 | slack.mjs:91 2xx invalid body retried | resolved (non-retryable, `maybe_delivered` -> ledger `sent-unknown`, deduped) |
| 3 | emit.mjs:98 stdin cwd as .env source | resolved (only absolute `CLAUDE_PROJECT_DIR`; inherited `CHAT_BRIDGE_PROJECT_DIR` stripped) |
| 4 | lost wakeup | resolved (re-check `hasPendingWork` after `release()`, up to 10 rounds; window closed since check runs after unlock) |
| 5 | rotation loses appends | resolved (2500 ms settle > hook `timeout: 2`, second drain, delete only when fully read) |
| 6 | ledger unbounded / head read | resolved (30-day TTL prune, 8 MiB tail read) |
| 7 | stale-lock takeover race | resolved (rename-aside + compare + link-back, verify-after-create, heartbeat loss -> stop). Residual: between rename and link-back a third sender can create; holder detects loss within one heartbeat (5 s). Accepted, ledger dedup covers most of it |
| 8 | A1 roles not required | resolved (runtime + schema) |
| 9 | relative CHAT_BRIDGE_CONFIG vs cwd (also L3) | resolved |
| 10 | redaction invisible-char bypass (also M1) | resolved (NFKC + `\p{Cf}`/`\p{Default_Ignorable_Code_Point}`; soft hyphen and tag chars masked) |
| ❓ | outcome `error` vs `failure` | resolved by ADR A4-c |

M2 probes (quoted key, Basic, `mysql -p`) are now masked (verified).
(c) Rotation: 2500 ms settle plus delete-only-when-fully-read is correct, given Claude Code kills hooks at `timeout: 2`. Lock takeover: correct apart from the residual noted in row 7.
(d) RULES_VERSION 1.2.0: the code and all 33 fixtures agree, but the ADR does not record it (see below).
(b) Edited QA tests: the assertion edits match the new behaviour and nothing was loosened (exact `deepEqual`s are kept). However, us-005 and review-fixes encode the A8 deviation below.

### Findings
```
integrations/chat/src/bus/safe-fs.mjs:40: 🔴 bug: L2 parent check uses lstat, so a symlinked parent (project dir reached through a symlink, or CHAT_BRIDGE_SPOOL_DIR under one) reports mode 0777 without sticky bit -> spool_parent_world_writable -> every hook ends emit_failed and the bridge silently posts nothing. Verified: ensureSpoolDir('<tmp>/link/.chat-bridge') with link -> real dir throws. Use statSync (follow) for the parent, or realpath the dir first; add test.
integrations/chat/src/core/detect-gates.mjs:8: ❓ question: A8 makes GATE_OWNERS include release -> release-manager, but there is no release receipt format, header or gate enum value. Should A8 drop it, or should a release gate be added (schema change)?
integrations/chat/src/core/map-claude-hook.mjs:90: 🟡 risk: deviates from ADR A8. A receipt on a non-owner SubagentStop is dropped (note gate_actor_mismatch), but A8 says it is still posted with actor = normalized agent_type and marked "relayed (unverified)". Tests test/app/review-fixes.test.mjs:303 and test/acceptance/us-005-emitter.test.mjs:52 assert the drop, contradicting A8's QA spec ("does not post as Security and is marked relayed"). Fix: keep all gates, actor = hook==='Stop' ? 'pm' : sourceActor (format-text.mjs:41 already renders the relay marker when actor != owner), and update both tests. Or amend A8 to "drop".
integrations/chat/src/app/sender.mjs:210: 🟡 risk: a .draining file with unread trailing bytes (partial or garbage last line) is never removed (also L243). hasPendingWork (L339) then stays true, so every later sender runs all 10 wakeup rounds (about 20 s or more, holding the lock) forever. Dead-letter the trailing remainder after the settle, or have hasPendingWork ignore leftovers that made no progress.
integrations/chat/src/core/redact.mjs:4: 🟡 risk: RULES_VERSION bumped to 1.2.0, but ADR-0003 still says 1.1.0 (A6) and has no change-log entry. Contract traceability: event.redaction.rules_version no longer matches any documented ruleset. Add an A6 addendum or change-log line listing the M1/M2 rules.
totals: 1🔴 3🟡 1❓
```

---

## Re-review 2 (after Backend fixes for Re-review 🔴×1 🟡×3 ❓×1)

```
REVIEW RECEIPT
Diff: feature/chat-bridge working tree vs HEAD e28b731 (uncommitted), delta since Re-review: src/bus/safe-fs.mjs, src/core/map-claude-hook.mjs, src/core/detect-gates.mjs, src/app/sender.mjs, src/core/redact.mjs (comment), docs/adr/0003-chat-bridge.md (A6 addendum 1.2.0, A8, A11), integrations/chat/README.md (new), integrations/chat/slack/manifest.yml (new), test/acceptance/review-security-fixes.test.mjs (new)
Reviewer: cavecrew-reviewer
Findings: 🔴 0 | 🟡 3 | 🟢 0
Veredicto: APPROVED
Fecha: 2026-11-11
```

Local: `npm test` 704/704 pass, coverage 99.40% lines / 97.10% branches; `npm run lint` clean.

### Re-review findings: status
| # | Finding | Status |
|---|---|---|
| 🔴 | safe-fs.mjs:40 symlinked parent -> spool_parent_world_writable | resolved (`realpath` + `stat` of parent). Verified: `<tmp>/link/.chat-bridge` with link -> 0755 dir is accepted; a spool dir that is itself a symlink is still refused (`spool_dir_unsafe`) |
| 🟡 | map-claude-hook.mjs:90 A8 deviation (drop vs relay) | resolved (all gates kept; actor = owner only on owner SubagentStop, else `pm` for Stop / normalized agent_type; format-text marks "Relayed (unverified)"; tests cover owner, non-owner, PM Stop, owner-first and relay-first dedup per gate) |
| 🟡 | sender.mjs:210 unread .draining tail never removed | resolved (`finishRotated` dead-letters `rotation_leftover`, no content, then deletes and resets cursor) |
| 🟡 | redact.mjs:4 RULES_VERSION 1.2.0 undocumented | resolved (ADR A6 addendum + change-log line) |
| ❓ | GATE_OWNERS release entry | resolved (removed; ADR A8 defers release gate to F2) |

README checked against code: env allowlist (4 emitter keys + `SLACK_BOT_TOKEN` sender-only), config defaults/ranges (match `config.v1.schema.json`), spool errors, `gate_relayed` / `rotation_leftover` log codes, relay rule. No mismatch.
Manifest: bot scopes exactly `chat:write`, `chat:write.customize`; no user scopes, Socket Mode off, no events/interactivity/commands. OK.

### Findings
```
docs/adr/0003-chat-bridge.md:491: 🟡 risk: A11 says the parent *chain* is checked after realpath; code checks only the immediate parent (safe-fs.mjs:52). A world-writable non-sticky grandparent lets another user rename the project dir and swap the spool. Either walk ancestors in ensureSpoolDir or amend A11 to "immediate parent".
docs/adr/0003-chat-bridge.md:501: 🟡 risk: risk table still lists "A8 not yet implemented"; A8 is now implemented and tested. Update or close the row so the ADR does not misstate open risk.
integrations/chat/src/app/sender.mjs:343: 🟡 risk: no-progress break can reintroduce the lost wakeup. A redundantly spawned sender that drained nothing (progress 0) and saw an emitter append after its idle decision but before release() (emitter saw live lock, skipped spawn) breaks instead of re-looping -> event stuck until next hook. Break only when pending state (outbox size/inode + cursor) is unchanged since the round started.
totals: 0🔴 3🟡 0❓
```

- 🟡 findings to be logged as issues per STANDARDS §4. Merge not blocked.
