# Review: Team Chat Bridge F2 (integrations/chat)

```
REVIEW RECEIPT
Diff: da8a1cc..8e14d88
Reviewer: cavecrew-reviewer
Findings: 🔴 0 | 🟡 5 | 🟢 3
Veredicto: APPROVED
Fecha: 2026-11-11
```

Contract: ADR-0003 A13.1–A13.5. Local DoD evidence: `npm test` 853/853 pass; `npm run lint` clean; coverage 99%+ líneas.

Sin 🔴. De los 5 🟡, dos tocaban un invariante de seguridad y se corrigieron durante el gate (`8e14d88`); el resto y los 🟢 quedan como deuda registrada.

## Findings

```
opencode/plugin.js:219: 🟡 risk: chat.message capturaba texto del usuario (role "user"), sembrando texts con el prompt. FIXED en 8e14d88: solo texto de asistente (role desde message.updated); part sin rol se descarta. Test "never publish user prompt text".
src/config/load-config.mjs:31: 🟡 risk: ci no estaba en REQUIRED_ROLES ni en el required del schema; identities.json sin ci validaba y el gate CI se renderizaba como "Agent". FIXED en 8e14d88.
opencode/plugin.js:191: 🟡 risk: tras reload, session.idle de una sesión hija no reconocida cae a la rama root y emite un gate.result duplicado con atribución/correlación incorrectas. (backlog) marcar sesiones desconocidas como no-root.
opencode/plugin.js:99: 🟡 risk: pendingByParent guarda un solo agentType por padre; con dos subagentes concurrentes del mismo padre, el started del primero toma el tipo del segundo. (backlog) preferir info.agent del Session o cola FIFO.
src/config/load-config.mjs:272: 🟡 risk: key de mentions que es rol Y alias a la vez no resuelve rol explícito. (backlog) rechazar colisión en validateIdentities.
opencode/plugin.js:216: 🟢 nit: texts guarda solo la última parte; un receipt en una parte anterior se pierde. (backlog) acumular por messageID.
src/bus/threads.mjs:52: 🟢 nit: pruneThreads lee threads.json dos veces. (backlog)
.github/workflows/ci.yml:199: 🟢 nit: counts fijo 0/0 y summary "CI: CI success" aun en FAIL. (backlog) omitir counts salvo cálculo real; summary "CI <conclusion>".
```

## Notas

- El hallazgo de `chat.message` dependía de la semántica de OpenCode (no verificado en runtime 2.2.7); se cerró de forma defensiva (solo texto de asistente; ante duda, descarta en vez de publicar).
- Los 🟡/🟢 restantes son deuda no bloqueante; ver también `docs/security/2026-11-11-chat-bridge-f2.md` (M1 y L1–L6).
