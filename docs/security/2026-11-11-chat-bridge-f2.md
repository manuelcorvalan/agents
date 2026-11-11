# Security gate: F2 Team Chat Bridge (sin Discord)

- **Scope:** `integrations/chat/` (emisor OpenCode, threads, mentions, gate `ci`, L2) y `.github/workflows/ci.yml` (job `ci-gate`). Commits `da8a1cc..8e14d88`.
- **References:** `STANDARDS.md` §5, ADR-0003 A13, `docs/security/2026-11-11-chat-bridge-f1.md` (M1–M3 cerrados, L2/L3).
- **Owner:** Security agent. **Date:** 2026-11-11.

```
SECURITY RECEIPT
Release: 0.2.0 (F2)
Secret-scan: PASS
Dependency audit: 0 high / 0 critical
Authz/Authn review: PASS
Veredicto: APPROVED
Fecha: 2026-11-11
```

Aprobado con condiciones. Ningún hallazgo crítico. Un hallazgo **HIGH** fue corregido durante el gate (`3d2c257`); los hallazgos MEDIUM/LOW van al backlog.

---

## 1. Secret-scan — PASS

- `grep` de patrones (`sk-…`, `xox[bap]-…`, `ghp_…`, `AKIA…`, `Bearer …`) sobre `integrations/chat/` y `.github/workflows/ci.yml`: 3 hits, todos falsos positivos (`xoxb-111111111111` en tests negativos que verifican rechazo de canal inválido).
- `git log -p da8a1cc..8e14d88`: 0 hits.
- `config/config.json` no versionado (`integrations/chat/.gitignore:3`); `config.example.json` solo placeholders (`C0000000000`, `mentions: {}`); `.env` en `.gitignore:10`.

## 2. Dependency audit — 0 high / 0 critical

`npm audit --audit-level=high` en `integrations/chat`: 4 moderadas dev-only (`minimatch` vía `eslint@10`, GHSA-g3hv-75wg-m249). Runtime deps: 0. No bloquea.

## 3. Authz/Authn review — PASS

Sin rutas HTTP. Superficie fail-closed:
- Canal solo de `config.channels`/`default_channel`, re-validado `^[CDG][A-Z0-9]{8,}$` antes del POST.
- Endpoint allowlist exacta `https://slack.com/api/chat.postMessage`, `redirect: 'error'`.
- Token solo en header `Authorization`, nunca logueado ni retornado.
- Sin IDOR / multi-tenant / bypass de auth.

## 4. Threat model F2 (outbound, sin Discord)

- **Mentions (A13.3):** suficiente para F2, sin bypass de inyección. Doble barrera (`mentionTarget` exige handoff + allowlist + regex `^U[A-Z0-9]{8,}$`; adapter reconstruye `<@id>` post-escape y re-valida). Texto libre escapa `&<>`; `link_names:false`. Riesgo residual firmado (agente mal portado pinguea a humano del allowlist) aceptado para F2; re-revisar antes de F3.
- **OpenCode emitter (A13.1):** sin shell (`spawn` array + stdin JSON). `prompt`/`model`/`background` descartados. `last_text` solo texto de asistente (ver HIGH). Pasa por D7 sí o sí.
- **Gate ci (A13.4):** no forjable por texto (`ci` fuera de `detect-gates` headers). Token no se expone en logs del workflow.
- **Threads (A13.2):** `threads.json` 0600 en spool dir 0700; clave = hash no reversible; sin fuga.
- **L2 (A13.5):** walk de ancestros completo; fail-open acotado (TOCTOU, explotable solo por quien controla permisos del árbol).

## 5. Findings

### Critical: none
### High
- **[H1 — FIXED en `3d2c257`] RCE por repo abierto.** `opencode/plugin.js` spawneaba `join(projectDir, 'integrations/chat/bin/chat-emit.mjs')` antes de verificar `CHAT_BRIDGE_ENABLED`. Plugin global → abrir un repo malicioso ejecutaba código node arbitrario. **Fix:** guard temprano `if (process.env.CHAT_BRIDGE_ENABLED !== 'true') return {};` (el plugin solo spawnea si el usuario habilitó el bridge; `chat-emit.mjs` sigue resolviendo `.env`/config de forma autoritativa).

### Medium
- **[M1] Recibo `ci` sin autenticidad.** Un proceso local con shell puede forjar un `gate.result` con `actor:"ci"` que se renderiza como propio (no relay). No es merge gate. → HMAC/firma CI, o tratar `ci` como relay salvo firma válida.

### Low
- **[L1]** `counts` hardcodeado `{high:0,critical:0}` en `ci-gate` aun con audit FAIL. → derivar counts del job `audit`.
- **[L2]** `SLACK_BOT_TOKEN` en job que ejecuta código de main; hoy innecesario (config de ejemplo = dry-run). → quitar secret hasta config real.
- **[L3]** `.env` del repo controla canales/token del sender si el bridge está habilitado ahí. → documentar; opt-in explícito.
- **[L4]** `thread_ref` sin validación de forma (`^\d{10}\.\d{6}$`). → defense in depth.
- **[L5]** Mapas del plugin (`texts`, `children`, `pendingCalls`) sin poda por sesión cerrada. → poda.
- **[L6]** L2 fail-open con TOCTOU (acotado). → aceptado F2, revisar F3.

## 6. Residual risk (heredado de F1, vigente)

Resúmenes son texto LLM no confiable publicado bajo identidad de agente. Bare URLs siguen clickeables (A10: defang o allowlist antes de F3). El canal debe ser privado y los mensajes son informativos/no verificados (la fuente autoritativa son los receipts en `docs/reviews/` y `docs/security/`).
