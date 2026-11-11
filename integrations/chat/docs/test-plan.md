<!--
  Basado en templates/test-plan.md (Owner: QA, agents/qa.md).
-->

# Test Plan: US-012 / Team Chat Bridge F1 (US-004..US-011)

- **Story / Feature**: US-012 — QA del Team Chat Bridge F1 (PRD Core Feature 6; criterios de éxito 7–12; ADR-0003 D1–D16 + A1–A10)
- **Owner**: QA
- **Entorno**: dev local (Node ≥ 22.13; ejecutado en Node 26.12), Linux. Sin red real: `fetch` inyectado, mock HTTP en loopback o preload que bloquea `fetch`.
- **Fecha**: 2026-11-11
- **Rama**: `feature/chat-bridge`
- **Receipts**: review `docs/reviews/2026-11-11-chat-bridge-f1.md` (re-review en curso), security `docs/security/2026-11-11-chat-bridge-f1.md`
- **Revisión 2** (2026-11-11): regresión tras los fixes de BUG-QA-001..004, review 9🟡 y security M1/M2/M3/L2/L3; escenarios S12.x añadidos.

## Estrategia

| Nivel | Qué | Dónde |
|---|---|---|
| Unit | funciones puras `src/core/*`, bus, config, adapters | `test/core`, `test/bus`, `test/config`, `test/adapters` (Backend) |
| Contrato | ajv (2020-12 strict) ↔ validador runtime sobre fixtures y corpus de mutaciones; contrato `chat.postMessage` | `test/core/validate-event.test.mjs`, `test/acceptance/schema-parity.test.mjs`, `test/acceptance/us-006-007-*.test.mjs` |
| Integración | `runEmit` → spool → `runSender` con reloj falso y `random` inyectado | `test/app/*`, `test/acceptance/*` |
| E2E in-process | hook payload → `runEmit` → spool → `runSender` → adapter Slack → **mock HTTP `chat.postMessage` en 127.0.0.1** | `test/e2e/slack-pipeline.test.mjs` |
| E2E proceso | `bin/chat-emit.mjs` real → spool → `bin/chat-send.mjs` real (detached), con `NODE_OPTIONS=--import` que reemplaza `fetch` por un recorder que falla como caída de Slack (heredado por el sender) | `test/e2e/process-pipeline.test.mjs` |

Reglas: determinismo (reloj falso, `random` fijo), aislamiento (tmp dir por test, `CLAUDE_PROJECT_DIR` = tmp, nunca se lee el `.env` del repo), tokens centinela con forma real pero inválidos (`FAKE_SLACK_TOKEN`), corpus de secretos armado en runtime para no disparar secret-scan. Bugs conocidos se registran como tests `todo` (se ejecutan, no rompen CI, pasan a verde cuando se corrija el bug: quitar `todo`).

> Nota: el backlog aprobado no está en el repo; los AC por story se tomaron del brief del PM (US-005..011) y US-004 se asume = contratos `identities.json`/`config.json` + normalización de roles.

## Escenarios

### US-004 — Identities / config contracts
- **S4.1** Given `config/identities.json`, When se valida con ajv y runtime, Then ambos aceptan; existe identidad para cada `agents/<rol>.md` (A1).
- **S4.2** Given mutaciones de identities (rol faltante, alias encadenado, emoji/color inválidos, claves extra, `icon_url`), When se validan, Then runtime rechaza; ajv coincide salvo reglas cross-ref documentadas (alias target faltante, alias encadenado).
- **S4.3** Given mutaciones de config, When se validan, Then runtime == ajv salvo "regex no compilable" (runtime-only).

### US-005 — Hook emitter
- **S5.1** Given `CHAT_BRIDGE_ENABLED` ausente/`false`/`1`/`TRUE`/` true`, When corre el hook, Then exit 0, 0 bytes stdout, sin spool, sin spawn, sin leer config, 0 llamadas de red.
- **S5.2** Given stdin basura / vacío / array / `null` / > 1 MB / stdin que nunca cierra, When corre `bin/chat-emit.mjs`, Then exit 0, 0 bytes stdout, ≤ 2 s, nada spooleado.
- **S5.3** Given modo live + token + Slack caído, When corre el hook real (sender detached real), Then hook exit 0 en ≤ 2 s con 0 stdout; el sender intenta, dead-letterea `network_error` y libera el lock.
- **S5.4** Given los 4 hooks (PreToolUse Agent/Task, SubagentStart, SubagentStop con receipts, Stop), When se spoolea, Then cada evento valida contra `event.v1` con **ajv**; línea ≤ 4 KB.
- **S5.5** Given `tool_input` con `prompt`, `model`, `isolation`, `run_in_background`, objetos anidados, When se mapea un handoff, Then `data` tiene solo `to` + `task_title` y la línea del spool no contiene ningún otro campo.
- **S5.6** Given emit path en modo live con token, When se ejecuta, Then `globalThis.fetch` no se llama nunca.

### US-006 — Slack adapter
- **S6.1** Given cualquier rol/alias/nombre desconocido, When se renderiza, Then `username` = `display_name + " (agent)"`, `icon_emoji` del rol, nunca `icon_url`.
- **S6.2** Given mock `fetch` y mock HTTP, When se envía, Then `POST https://slack.com/api/chat.postMessage`, headers exactos (`Content-Type: application/json; charset=utf-8`, `Authorization: Bearer <token>`), `redirect: "error"`, signal de timeout, body con exactamente `blocks, channel, icon_emoji, link_names:false, text, unfurl_links:false, unfurl_media:false, username`.
- **S6.3** Given errores no-retryables (`invalid_auth`, `missing_scope`, …) o errores de `fetch` que contienen el token en `message`/`cause`, When se envían, Then resultado con códigos fijos, dead-letter inmediato, `bridge.log` solo `code status attempts`, sin token.
- **S6.4** Given redirect 302, When se envía, Then no se sigue (`network_error`); Given servidor colgado, Then aborta en `timeout_ms` (`timeout`).

### US-007 — Routing / startup validation
- **S7.1** Given `channels: {}`, When se envían los 4 tipos, Then todos van a `default_channel`. Given mapping parcial, Then mapeados a su canal y el resto a default.
- **S7.2** Given `default_channel` ausente / vacío / `#general`, When arranca, Then `ConfigError config_invalid` con detalle `default_channel: invalid channel id`, ajv también rechaza, emitter no spoolea, sender `{started:false, reason:'config_invalid'}` y `bridge.log` registra `sender_refused config_invalid`.

### US-008 — Redacción
- **S8.1** Given cada patrón del corpus D7 + A6 (26 casos: Slack/GitHub/GitLab/npm/OpenAI/Stripe/AWS/Google/Atlassian/JWT/Bearer/private key/URL creds/env line/key=value/`key: value`/api-key/zero-width y word-joiner partiendo tokens/hex y base64 de alta entropía), When aparece en `description` y en el reporte del subagente, Then no aparece en el spool ni en el payload Slack renderizado; `redaction.rules_version` = `RULES_VERSION`.
- **S8.2** Given diffs y bloques de código, Then se eliminan (`[code removed]`, líneas diff fuera).
- **S8.3** Given `extra_patterns`, Then se aplican en emitter y sender (`[REDACTED:custom]`).
- **S8.4** Given línea de spool manipulada (sin redactar), When el sender la publica, Then el segundo pase redacta todo.
- **S8.5** Given `redact()` que lanza, Then fail-closed: se descarta summary/título, `summary_dropped=true`, se conservan type/actor/target.

### US-009 — Límites de secretos
- **S9.1** Given token centinela en env, When corre todo el pipeline (éxitos, fallos, dead-letters, líneas corruptas que contienen el token), Then el token no aparece en outbox, cursor, ledger, dead-letter, bridge.log, dry-run.log, resultados ni argv del sender (`/proc/<pid>/cmdline`).
- **S9.2** Given `.env` del proyecto (tmp) con `SLACK_BOT_TOKEN`, When el hook arranca el sender, Then el token **no** viaja en el env de spawn (`/proc/<pid>/environ`) ni en argv; el sender lo lee de `.env` (D15) y postea con Bearer; claves no allowlisted no se propagan.
- **S9.3** Given config/identities con token o webhook, Then se rechazan (`*_contains_secret`) sin el valor en el mensaje.

### US-010 — Confiabilidad de entrega
- **S10.1** 429 con `Retry-After` (HTTP y body `ratelimited`) → espera exacta; luego 5xx → backoff 1 s × 2ⁿ (+ jitter [0,250) ms, cap 60 s); entrega única.
- **S10.2** Retryables persistentes → dead-letter `max_attempts` con la secuencia de sleeps exacta 1000/2000/4000/8000.
- **S10.3** Dead-letter de un evento no bloquea los siguientes; orden de spool preservado (incluye correlation ids y canales intercalados).
- **S10.4** Idempotencia: mismo hook reemitido y reinicio del sender → un solo post; reanudación desde el cursor tras crash.
- **S10.5** Throttle por canal a `per_channel_rate_per_sec` (1 → ≥ 1000 ms, 0.5 → 2000 ms exactos), incluso entre reintentos.
- **S10.6** Determinismo: dos corridas idénticas → misma línea de tiempo.

### US-011 — Disabled / dry-run
- **S11.1** Disabled (proceso real con preload de fetch): 0 llamadas de red, sin spool dir.
- **S11.2** Dry-run por defecto (proceso real): payload en `dry-run.log` (0600), 0 requests, nada a stdout; arranca sin token.
- **S11.3** `CHAT_BRIDGE_DRY_RUN=true` pisa `dry_run:false` → 0 requests.
- **S11.4** Eventos previsualizados en dry-run no se re-publican al pasar a live (A7).
- **S11.5** Live sin token → `missing_token`, 0 requests.

### Regresión de fixes (review + security) — `test/acceptance/review-security-fixes.test.mjs`
- **S12.1 (M3 / A8)** Given cada gate de `GATE_OWNERS` (review, dod, security), When el owner (incluido el alias `reviewer`) emite su receipt en `SubagentStop`, Then se publica con la identidad del owner y sin marca. When lo emite otro agente (backend, frontend, pm, unknown), Then nunca se usa la identidad del owner: se publica como el emisor con `Relayed (unverified): ` y `bridge.log` registra `gate_relayed:<gate>`. When el PM lo cita en `Stop`, Then se publica como `PM (agent)`, marcado.
- **S12.2 (A8 dedup)** Owner primero y relay del PM después → 1 post como owner. Relay primero y owner después → 1 post, sigue marcado (no se "promueve").
- **S12.3 (review slack.mjs:43)** Given un summary de 2000 chars de `<&>` (escapa ×4–5), When se publica, Then `text` y el texto del block tienen ≤ 3000 chars, terminan en `…`, sin entidad partida ni `<`/`>` sin escapar, y Slack acepta (0 dead-letter).
- **S12.4 (review slack.mjs:91)** 2xx con body no-JSON → 1 sola request, ledger `sent-unknown` (`message_ref: null`), sin dead-letter, no se re-publica tras reemitir; 4xx no-JSON → dead-letter `non_retryable invalid_response`, sin ledger.
- **S12.5 (lost wakeup)** Un hook que appendea durante el cierre del sender (lock tomado, no spawnea) se entrega en la misma corrida (`wakeup_recheck`).
- **S12.6 (rotation)** Un append al archivo `.draining` por un writer con el inode viejo se entrega antes de borrarlo.
- **S12.7 (ledger prune)** Entradas > 30 días se podan al arrancar; las recientes siguen deduplicando; líneas corruptas se descartan.
- **S12.8 (lock takeover + BUG-QA-003)** `sender.lock` con pid vivo y heartbeat fresco → `lock_held`, 0 requests; heartbeat > `STALE_AFTER_MS`, pid muerto o lock corrupto → takeover y entrega, sin archivos `.stale` residuales. Durante un `Retry-After` de 20 min el holder sigue con heartbeat y un segundo sender es rechazado.
- **S12.9 (BUG-QA-004)** `extra_patterns: ["(a+)+$"]` → emitter y sender rechazan con `config_invalid` en < 1 s y `bridge.log` nombra `extra_patterns`.
- **S12.11 (rotation leftover)** Una línea parcial sin newline que queda en el `.draining` asentado → dead-letter `rotation_leftover` sin contenido (el token no llega al dead-letter), el archivo se borra y el sender termina (no hay loop de wakeup sin progreso).
- **S12.12 (A11 / L2)** Un project dir al que se llega por symlink funciona (el padre se valida con realpath); un spool dir que es symlink se rechaza y no se escribe nada en el destino.
- **S12.10 (M1 / M2 corpus)** +20 casos en el corpus (ver S8.1): caracteres invisibles (U+00AD, U+034F, U+061C, U+115F, U+1160, U+17B4, U+180E, U+3164, U+FE0F, U+FFA0, U+E0020, fullwidth NFKC) partiendo tokens; claves entre comillas JSON/Python, `=>`, `Basic`, `mysql -p`, `--password=`/`--password v`, valor en la línea siguiente. Control positivo: cada caso debe producir un marcador `[REDACTED:` en el título y en el summary (no solo "no filtró").

## Data de Test

| # | Dato | Valor | Origen |
|---|------|-------|--------|
| 1 | Token Slack centinela | `xoxb-<fake-sentinel>` (armado en runtime; nunca válido) | `test/helpers/fixtures.mjs` |
| 2 | Corpus de secretos (46: D7 + A6 + M1 + M2) | ver S8.1 | `test/helpers/secret-corpus.mjs` |
| 3 | Fixtures `event.v1` | 9 valid / 24 invalid | `schema/fixtures/` |
| 4 | Config / identities | `config/config.example.json`, `config/identities.json` + mutaciones | repo + tests |
| 5 | Mock Slack HTTP | `node:http` en 127.0.0.1:0, script de respuestas (429/5xx/302/hang/error body) | `test/helpers/mock-slack.mjs` |
| 6 | Bloqueo de red a nivel proceso | `NODE_OPTIONS=--import=test/helpers/no-network-preload.mjs` | `test/helpers/no-network-preload.mjs` |
| 7 | Reloj / jitter | `fakeTime()` (sleep avanza el reloj), `random` fijo | `test/helpers/env.mjs` |
| 8 | `.env` de proyecto | archivo tmp 0600 en `CLAUDE_PROJECT_DIR` tmp (nunca el `.env` real) | `test/e2e/process-pipeline.test.mjs` |

## Resultados

**Revisión 2 (vigente).** `npm test` (node:test + coverage, umbral 80/80): **704 tests, 704 pass, 0 fail, 0 todo** en 4 corridas consecutivas, sin fallos. Una corrida mostró coverage menor (97.28 / 95.06) porque Backend estaba editando `redact.mjs` en paralelo; no fue un flake de tests y la corrida siguiente volvió a 99.40 / 97.10. 139 de esos tests son de QA (`test/e2e`, `test/acceptance`). `npm run lint`: 0 errores. Coverage **99.40 % líneas / 97.10 % branches** (mínimo por archivo: `transcript.mjs` 89.13 % branches). `npm audit --audit-level=high`: exit 0; 4 moderadas solo de dev (minimatch vía eslint 10, Security L1); `--omit=dev`: 0.

Revisión 1 (histórico): 549 tests, 545 pass / 4 todo; 99.46 % / 97.00 %.

| Escenario | Resultado esperado | Resultado actual | Estado |
|-----------|--------------------|------------------|--------|
| S4.1–S4.3 | contratos válidos, paridad ajv salvo reglas runtime-only documentadas | idem (A1: cavecrew-builder/-investigator requeridos en runtime + schema) | PASS |
| S5.1 | no-op total si disabled | idem (proceso real e in-process) | PASS |
| S5.2 | exit 0, 0 stdout, ≤ 2 s | stdin abierto: ~1.5 s; resto < 50 ms | PASS |
| S5.3 | hook ≤ 2 s con Slack caído | hook < 2 s; sender dead-letter `network_error`, lock liberado | PASS |
| S5.4–S5.6 | ajv valida todo; solo `to`/`task_title`; 0 fetch | idem | PASS |
| S6.1–S6.4 | contrato `chat.postMessage` exacto; errores sin token | idem | PASS |
| S7.1 | unmapped → default_channel | idem | PASS |
| S7.2 | fallo de arranque con mensaje claro | rechaza y `bridge.log` nombra `default_channel` | PASS (BUG-QA-002 corregido) |
| S8.1–S8.5 | ningún secreto en spool/payload; fail-closed | idem (46/46 patrones, con control positivo) | PASS |
| S9.1–S9.3 | token fuera de spool/logs/argv/env de spawn | idem | PASS |
| S10.1–S10.6 | retry/backoff/dead-letter/idempotencia/throttle/orden deterministas | idem | PASS |
| S10.x lock | un solo sender a la vez | heartbeat + takeover atómico; segundo sender rechazado | PASS (BUG-QA-003 corregido) |
| S11.1–S11.5 | 0 red en disabled/dry-run | idem | PASS |
| S11.x sender disabled | sender no publica si `CHAT_BRIDGE_ENABLED != true` | `{started:false, reason:'disabled'}`, 0 requests | PASS (BUG-QA-001 corregido) |
| S5.x deadline | hook ≤ 2 s incluso con `extra_patterns` patológico | el patrón se rechaza en la validación de config | PASS (BUG-QA-004 corregido) |
| S12.1–S12.2 | atribución por owner (A8), relay marcado, dedup sin "promoción" | idem, 3 gates | PASS |
| S12.3–S12.4 | ≤ 3000 chars tras escapar; `sent-unknown` | idem | PASS |
| S12.5–S12.8 | lost wakeup, rotación, prune del ledger, takeover del lock | idem | PASS |
| S12.9–S12.10 | ReDoS rechazado; corpus M1/M2 enmascarado | idem | PASS |
| S12.11–S12.12 | leftover de rotación a dead-letter; reglas de symlink de A11 | idem | PASS |

**Verificación de los tests de QA editados por Backend** (no se debilitó ninguna aserción):
- `us-005-emitter`: la lista esperada de tipos cambió por A8. El `REVIEW RECEIPT` embebido en el `SubagentStop` de qa ya no se publica como Reviewer; ahora es un relay marcado que se deduplica. El resto de las aserciones no cambió.
- `us-010-011-delivery` (lock): ya no es `todo`. Se añadió `first.heartbeat(...)` para simular el heartbeat del holder. Es válido porque el fix es el heartbeat, y S12.8 lo prueba con el sender real durante un `Retry-After` de 20 min.
- `slack.test`: un 2xx no-JSON ahora es `retryable:false` con `maybe_delivered`, como pide la review. Es más estricto.
- `e2e/*` y `us-006-007`: solo se quitaron los `todo`; las aserciones son las mismas.
- Nit 🟢: `test/app/qa-bugfixes.test.mjs` "refresh the lock heartbeat during a long retry wait" solo verifica que `heartbeat_at` sea un string, cosa que ya es cierta al crear el lock. S12.8 cubre la propiedad real.

## Bugs

| ID | Sev. | Descripción | Estado |
|---|---|---|---|
| BUG-QA-001 | 🟡 | `runSender` no verificaba `CHAT_BRIDGE_ENABLED` (D10). | **Cerrado**: `slack-pipeline` "sender when the bridge is disabled" y `qa-bugfixes` |
| BUG-QA-002 | 🟡 | `bridge.log` no nombraba el campo de config inválido. | **Cerrado**: `us-006-007` "name the offending field" |
| BUG-QA-003 | 🟡 | Lock sin heartbeat → takeover de un sender vivo de más de 15 min. | **Cerrado**: heartbeat cada 5 s, stale a los 30 s sin heartbeat, takeover atómico (S12.8) |
| BUG-QA-004 | 🟡 | El deadline de 1500 ms no interrumpe un regex síncrono catastrófico. | **Cerrado (mitigado)**: guard ReDoS en la validación de `extra_patterns`, entrada acotada a 64 KiB y segmentos de 256 chars (S12.9). El deadline sigue sin interrumpir trabajo síncrono; el riesgo queda acotado por el guard |
| BUG-QA-005 | 🟡 | Durante la ronda de fixes, el receipt de un agente que no es owner se descartaba en lugar de publicarse como relay (A8). | **Cerrado**: Backend lo alineó con A8 en esta misma ronda; S12.1 y "a backend agent emitting a SECURITY RECEIPT" |
| OBS-1 | 🟢 | Pérdida en la ventana de rotación. | **Cerrado**: settle de 2.5 s + segundo drenaje (S12.6) |
| OBS-2 | 🟢 | Handoff sin `tool_use_id` → `event_id` fijo por sesión. | Abierto (Claude Code siempre envía `tool_use_id`) |
| OBS-3 | 🟢 | A8 + dedup D4: si un agente que no es owner publica primero un receipt idéntico, el post verificado posterior del owner se suprime y solo queda el relay. Cualquier agente puede degradar la atribución, pero nunca suplantarla. | Abierto: aceptado por A8 ("never upgraded"); se sugiere incluir el actor en el fingerprint en F2 |
| OBS-4 | 🟢 | A8 listaba `release → release-manager` en `GATE_OWNERS`, sin gate `release` en el schema. | **Cerrado**: el ADR se enmendó y el gate de release se difiere a F2 |
| Security M4 | — | `.env` del repo con modo 0644 (acción del operador). QA no lo verificó: no se lee `.env`. | Pendiente del operador |

## Resumen

- **Total**: 49 escenarios (34 de S4–S11, 3 de regresión de bugs, 12 de S12)
- **PASS**: 49
- **FAIL**: 0
- **Bloqueantes**: 0 🔴. Abiertos: 2 🟢 (OBS-2, OBS-3) y Security M4, que es acción del operador.
