# Security gate: F1 Team Chat Bridge (pre-release)

- **Scope:** `integrations/chat/` (chat-bridge 0.1.0), hooks in `.claude/settings.json`, `chat-bridge` job in `.github/workflows/ci.yml`. Branch `feature/chat-bridge`, uncommitted working tree.
- **References:** `STANDARDS.md` §5, ADR-0003 (D2, D3, D7, D15, D16, Amendments A1–A7), PRD Core Feature 6.
- **Companion review receipt:** `docs/reviews/2026-11-11-chat-bridge-f1.md`.
- **Owner:** Security agent. **Date:** 2026-11-11.

```
SECURITY RECEIPT
Release: 0.1.0
Secret-scan: PASS
Dependency audit: 0 high / 0 critical
Authz/Authn review: PASS
Verdict: APPROVED
Date: 2026-11-11
```

The release is approved with conditions. There are no critical or high findings. Four medium findings go to the backlog and must be fixed before F2 (threads) or F3 (inbound) starts. M4 is an operator action that should be done now.

---

## 1. Threat model (F1, outbound only)

### Assets
- `SLACK_BOT_TOKEN` (scopes `chat:write` and `chat:write.customize`).
- Any other secrets in the local `.env`.
- Secrets or code that may appear in agent output.
- The team's Slack channel: its integrity and how much people trust it.
- The developer workstation: the files under `.chat-bridge/`.

### Actors
- The local developer, who is trusted.
- Claude Code, which supplies the hook stdin and is trusted.
- LLM agents. Their output is **semi-trusted**, because it can carry prompt-injected content from repo files, web pages or tool results.
- Slack readers.
- Another local user, on a shared host.

### Trust boundaries and data flow
```
Claude Code hook stdin (trusted JSON, capped at 1 MiB)
  -> bin/chat-emit.mjs (stdout muted, 1500 ms deadline, exit 0)
  -> load-env (emitter allowlist, never SLACK_BOT_TOKEN)
  -> map-claude-hook (reads only subagent_type and description from tool_input; never prompt)
       + transcript.mjs (agent_transcript_path only, absolute, lstat + O_NOFOLLOW, 64 KB tail)
  -> redact (redact -> truncate -> redact, fails closed) -> validate-event (strict schema)
  -> spool .chat-bridge/outbox.jsonl (dir 0700, files 0600, lstat + O_NOFOLLOW, 4 KB lines)
  == boundary: emitter process -> detached sender process (env only, argv = [send.mjs]) ==
  -> sender: load-env (sender allowlist, token from .env) -> parse untrusted line -> validate
  -> redact again -> formatText -> escapeMrkdwn -> slack adapter
  == boundary: host -> network ==
  -> https://slack.com/api/chat.postMessage (exact host and path, redirect:error, timeout)
```

I traced the flow by reading the code from the entry points (`bin/chat-emit.mjs`, `bin/chat-send.mjs`) to the sinks: `appendSafe` for spool, log and dry-run, `fetch` in `adapters/slack.mjs`, and `spawn` in `app/emit.mjs`. `codegraph_explore` was not in this agent's toolset for this run, so the trace is manual. It covers every module in `src/`.

### Attack surface and STRIDE summary

| Threat | Vector | Control | Status |
|---|---|---|---|
| Information disclosure: token | argv, logs, spool, errors | token only in sender env or `.env`; reason-code logs; no `err.cause` | OK |
| Information disclosure: secrets in agent text | summary or task title | D7/A6 redaction twice | gaps M1, M2 |
| Information disclosure: prompt or tool input | `tool_input.prompt` | not read; schema rejects extra fields | OK |
| Tampering: spool | symlink or planted files | lstat + O_NOFOLLOW, 0700/0600, schema validation in sender | OK (L2) |
| Spoofing: humans or Slackbot | username, icon | `" (agent)"` suffix fixed, `icon_emoji` only | OK |
| Spoofing: gate verdicts | receipt text in any agent output | none | M3 |
| Spoofing: mentions or links | `<!channel>`, `<url\|text>` | `escapeMrkdwn`, `link_names:false`, no unfurl | OK (bare URLs: residual) |
| SSRF or exfiltration | configurable endpoint or webhook | host and path allowlist, `redirect:"error"`, no webhooks | OK |
| DoS: hook latency | hung stdin, big payload | 1500 ms deadline, 1 MiB stdin cap, outer timeout 2 s | OK |
| DoS: ReDoS | `extra_patterns`, built-in rules | guard plus 256-char segments, 64 KiB input cap | OK |
| Elevation of privilege | `.env` loader | allowlist, owner/mode/symlink checks, no expansion | OK (M4: host config) |

---

## 2. Secret scan: PASS

- `gitleaks` is not installed on this host. I ran a grep scan instead, using gitleaks-equivalent patterns for Slack, GitHub, GitLab, npm, OpenAI-style, Stripe, AWS, Google and Atlassian tokens, JWTs, and PEM private keys.
- Scope: tracked plus untracked, non-ignored files (`git ls-files -co --exclude-standard`), the full history (`git log --all -p`) and the staged index.
- Result:
  - **0 real secrets** in the working tree, untracked files or history.
  - Nothing is staged.
  - The only match is the documented fake sentinel `xoxb-000000000000-FAKEFAKEFAKE-sentinel` in `integrations/chat/docs/test-plan.md:83`. It is not a valid token.
- The test corpus (`test/helpers/secret-corpus.mjs`) builds its tokens at runtime, so scanners do not flag it.
- `.env` is gitignored (`.gitignore:10`) and has never been committed (`git log --all -- .env` is empty). I did not read its contents.
- `.chat-bridge/` and `integrations/chat/config/config.json` are gitignored, as D16 requires.
- `.env.example` has empty placeholders only.
- The CI `secret-scan` job (gitleaks, full history) remains the authoritative check.

## 3. Dependency audit: 0 high / 0 critical

| Command | Result |
|---|---|
| `npm audit --omit=dev` | **0 vulnerabilities**. Runtime dependencies: none (D1). |
| `npm audit` | 4 moderate, all dev-only: `minimatch` GHSA-g3hv-75wg-m249 (ReDoS, ≥7.0.0 <11.0.1), pulled in by `eslint@10.14.0`, `@eslint/config-array` and `@eslint/js` |
| `npm audit --audit-level=high` (the CI gate) | exit 0 |

## 4. Authz/Authn review: PASS
- F1 has no inbound surface: no listener, no route, no webhook receiver. Slack never calls back into the bridge.
- The bot token has the minimal scopes `chat:write` and `chat:write.customize` (D14). It is validated against `^xoxb-[A-Za-z0-9-]{10,250}$`, so no user or app token is accepted.
- The sender refuses to start when the config is invalid, when a config file contains a secret, when the token is missing in live mode, or when the lock is held.
- `CHAT_BRIDGE_ENABLED` must equal `"true"` exactly in both processes.

## 5. F1 blocking items (ADR-0003 D7 and D15)

| # | Item | Evidence | Result |
|---|---|---|---|
| 1 | Redaction corpus passes | `npm test`: 593/593 pass, 0 todo; coverage 99.42% lines, 97.04% branches; `redact.mjs` 100/100. Lint clean. | PASS |
| 2 | Token never in argv, logs, spool or errors | Spawn argv is `[execPath, chat-send.mjs]` only (`app/emit.mjs`). The emitter allowlist excludes the token (`load-env.mjs`). The adapter returns fixed codes, and Slack's `error` must match `^[a-z0-9_]{1,64}$`. `log.mjs` sanitises details. Live probe: fake token in the temp project's `.env` plus a token in the transcript; grep of all `.chat-bridge/*` found **0 hits** for the token, a non-allowlisted `.env` key, and the `tool_input.prompt` marker. | PASS |
| 3 | Hook: zero stdout, exit 0, within budget | Probes across 4 hook types and non-JSON input: stdout 0 B, stderr 0 B, exit 0. Latency 60–80 ms per call (10 runs). Disabled path 37 ms. Hung stdin killed at 1563 ms (1500 ms deadline). Outer `timeout: 2`. | PASS |
| 4 | mrkdwn escaped | `escapeMrkdwn` runs on the whole rendered text, including headline, display names and summary. Probe: `<!channel> <@U123> <https://evil\|ok>` becomes `&lt;…&gt;`. `link_names`, `unfurl_links` and `unfurl_media` are all `false`. | PASS |
| 5 | Outbound host allowlist plus `redirect:error` | `isAllowedEndpoint`: `https:`, host `slack.com`, path `/api/chat.postMessage`, no userinfo, query or hash. `redirect:"error"` and `AbortSignal.timeout`. Channel id regex checked. No webhook support. | PASS |
| 6 | Spool perms 0700/0600 and no symlink follow | Observed dir `700`, files `600`. Probe: `outbox.jsonl` symlinked to a victim file was refused (`spool_file_unsafe`) and the victim was unchanged. A symlinked spool dir was refused, with nothing written to the target. | PASS |
| 7 | `.env` loader allowlist, emitter never gets the token | `EMITTER_ALLOWLIST` has no `SLACK_BOT_TOKEN`; the token is only in `SENDER_ALLOWLIST`. Non-listed keys are dropped. Probe: mode 0644 loaded with `env_mode_readable` warning; mode 0666 ignored (fail closed, bridge stays off). Never mutates `process.env`. | PASS |
| 8 | No prompt or extra `tool_input` forwarded | `mapHandoff` reads only `subagent_type` and `description`. Schema fixture `handoff-forwards-prompt.json` is rejected. Probe marker was absent from spool and payloads. | PASS |
| 9 | ReDoS guard on `extra_patterns` | Rejected: `(a+)+`, `(a\|aa)+`, `.*.*`, `\d+\d+`, `a{1,300}`, lookarounds, backreferences, nested quantified groups. Accepted: `[a-z]*x`, `[a-z]{1,16}@[a-z]{1,16}`. Hostile 60 KB input with four `*` patterns: 44 ms. Built-in rules on pathological inputs: ≤4 ms each. | PASS |

---

## 6. Findings

### Critical: none
### High: none

### M1 (Medium): Unicode default-ignorable characters bypass token masking
- **Evidence:** `CONTROL_AND_BIDI` in `src/core/redact.mjs` strips C0/C1, U+200B–200F, U+202A–202E, U+2060–2069 and U+FEFF. It does **not** strip U+00AD (soft hyphen), U+034F, U+180E, U+3164/U+115F/U+1160/U+FFA0, variation selectors U+FE00–FE0F or tag characters U+E0000–E007F.
- **Probe:** `xox­b-1234567890-abcdefghijkl` passed through unmasked. The same happened with U+034F, U+FE0F, U+E0020, U+180E and U+3164. Slack renders most of these invisibly, so a reader or a copy-paste can recover the token.
- **Exploitability:** it needs adversarial text, for example a prompt-injected agent told to obfuscate a secret it has seen. Natural text does not do this.
- **Remediation:** strip `/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu` (minus `\t` and `\n`) before matching, and consider `normalize('NFKC')` first. This only makes redaction stricter, so A6 allows it without an amendment. Add each character to the QA corpus.

### M2 (Medium): Quoted-key and other common secret forms are not masked
- **Evidence:** `SECRET_KEY_VALUE` needs the separator right after the key characters, so a closing quote breaks the match. Probes that leaked:
  - `{"password": "hunter2"}`
  - `{'api_key': 'shortkey1'}`
  - `token => "abc12345"` (the value leaks after the mangled marker)
  - `Authorization: Basic dXNlcjpwYXNz`
  - `mysql -pHunter2Pass`
  - `token:\n  hunter2`
- Long or high-entropy values are still caught by the entropy rule. The leaks are short, human-chosen secrets.
- **Remediation:**
  - allow an optional closing quote: `(["']?)[ \t]*(?:[:=]|=>)[ \t]*`;
  - add `\bBasic\s+[A-Za-z0-9+/=]{8,}`;
  - add CLI `-p<value>` / `--password[= ]<value>`;
  - add corpus entries for each.

### M3 (Medium): Gate verdicts can be spoofed in Slack
- **Evidence:** `detect-gates.mjs` gives `actor = GATE_OWNERS[gate]` based only on the receipt header. Any agent's output, or the PM `Stop` text, that contains `SECURITY RECEIPT` plus `Verdict: APPROVED` is posted as **"Security (agent)"** with "Security gate: PASS". The same applies to the review and DoD receipts. This includes a prompt-injected agent and a PM quoting an old receipt.
- **Impact:** Slack is informational and release decisions do not read from it. Still, people may trust a false PASS. This is an integrity problem.
- **Remediation, pick one:**
  - post `gate.result` only when the normalized source actor equals the gate owner, or is `pm` with "(relayed by PM)" in the rendered text;
  - otherwise always render the real source actor and not the owner identity.
- Add tests: a backend agent emitting a security receipt must not post as Security.

### M4 (Medium, operator action): `/home/manuel/agents/.env` is mode 0644
- **Evidence:** `stat` gives `644 manuel`. I did not read the contents. The file probably holds the Jira and Context7 credentials and, once configured, `SLACK_BOT_TOKEN`. Any local user can read it.
- The D15 loader accepts it with the warning `env_mode_readable`.
- **Remediation:**
  - run `chmod 600 /home/manuel/agents/.env` now;
  - add a `chmod 600 .env` step to the setup guide and to `bin/factory-init`;
  - consider making `env_mode_readable` a refusal for the sender when the file contains `SLACK_BOT_TOKEN`;
  - if the host is or was multi-user, rotate the credentials in it.

### L1 (Low): dev-only moderate CVE
- `minimatch` GHSA-g3hv-75wg-m249, pulled in by `eslint@10`.
- It runs only in CI and locally during lint, and is not shipped. The CI gate (`--audit-level=high`) passes.
- **Remediation:** bump eslint when a patched `@eslint/config-array` or `minimatch` ≥11.0.1 is released. Do not use `npm audit fix --force`, which would downgrade to eslint 9.

### L2 (Low): Spool directory ownership and parent path not verified
- `ensureSpoolDir` uses `lstat` on the final component only and does not check `uid`.
- `CHAT_BRIDGE_SPOOL_DIR` accepts any absolute path, for example under `/tmp/<attacker-dir>/…`. On a shared host, a pre-created directory owned by another user would be chmod-attempted and then used.
- The default `<project>/.chat-bridge` is not affected.
- **Remediation:** require `stat.uid === process.getuid()` for the spool dir, and refuse world-writable parents without the sticky bit. In the docs, recommend keeping the spool inside the project.

### L3 (Low/Info): `CHAT_BRIDGE_CONFIG` from the process env resolves against `cwd`
- `loadBridgeConfig` calls `resolve(env.CHAT_BRIDGE_CONFIG)`. Values from `.env` are already absolute (D15), but a relative value exported in the process env depends on `cwd`. The impact is only which config file is read, and that file is still validated and secret-scanned.
- **Remediation:** resolve against `projectDir`, as D15 does.

### Info
- I1: there is a literal fake token string in `docs/test-plan.md:83`. It is harmless, but it may trip future scanner rules. Consider writing it as `xoxb-<fake-sentinel>`.
- I2: `gitleaks` is missing locally, so CI's gitleaks job is authoritative. Install it locally (`pacman -S gitleaks`) for pre-commit use.
- I3: the temp-file name in `writeAtomic` is predictable (`<path>.<pid>.tmp`). That is mitigated by the 0700 directory and the lstat + O_NOFOLLOW checks, so no action is needed.

---

## 7. Residual risk: summaries are LLM output

**Statement:** after this gate, F1 still posts **untrusted, LLM-generated text** to a team channel under agent identities. This risk is accepted for F1, with the conditions below.

What the controls already neutralise:
- Mass mentions and user pings (`<!channel>`, `<!here>`, `<@U…>`) through escaping and `link_names:false`.
- Disguised links (`<url|text>`), which are escaped.
- Link previews: `unfurl_*` set to false.
- Human or Slackbot impersonation: forced `" (agent)"` suffix, no `icon_url`.
- Code and diffs, which are stripped.
- Control and bidi characters.
- Size: 500 chars and 8 lines by default.
- The text is never executed or used to choose a route. Routing uses only the event `type`.

What remains:
1. **Bare URLs are clickable.** Slack auto-links `https://…` in mrkdwn even with unfurl off. A prompt-injected agent can post a phishing or "re-auth" link under a trusted agent name.
2. **Social-engineering text**, such as "Security approved, please merge" or fake instructions to humans. M3 makes this worse for gate events.
3. **Secret leakage through obfuscation that redaction cannot see** (M1, M2), and through paraphrase, for example a token spelled out in words. Paraphrase cannot be prevented by pattern redaction.
4. **Workspace data disclosure.** Story titles and summaries reveal project content to everyone in the channel. Mitigate by using a private channel with restricted membership.

Recommended (non-blocking for F1, required before F3 inbound):
- defang URLs in summaries (`https://` → `hxxps://`, or wrap them in inline code so Slack does not linkify them), or allow only an allowlist of domains;
- fix M3 so gate posts come only from the owner;
- document in the setup guide that bridge messages are **informational and unverified**, that the authoritative gate status is the archived receipts in `docs/reviews/` and `docs/security/`, and that the channel must be private;
- keep `dry_run: true` as the default (it is) and review `dry-run.log` before switching to live.

## 8. Conditions and backlog
| ID | Action | Owner | When |
|---|---|---|---|
| M4 | `chmod 600 .env`; add to setup guide and `factory-init` | Operator / DevOps / Tech Writer | Now (before live mode) |
| M1, M2 | Harden redaction and extend the QA corpus | Backend + QA | Next sprint, before F2 |
| M3 | Owner-bound gate attribution plus tests | Backend + Architect (amend D6) | Next sprint, before F2 |
| Residual 1 | URL defanging or domain allowlist | Backend | Before F3 |
| L1–L3 | As described above | Backend / DevOps | Backlog |
