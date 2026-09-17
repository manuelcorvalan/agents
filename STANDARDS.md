# STANDARDS.md — Estándares de calidad de la software factory

Fuente de verdad de calidad para todo el equipo de agentes. Aplica a **todo** trabajo técnico, en OpenCode y Claude Code.

- **Owner:** QA (`agents/qa.md`) — custodia y valida el cumplimiento.
- **Reviewer:** `cavecrew-reviewer` — gate de code review.
- **Security:** `agents/security.md` — gate de seguridad (a crear).
- **Orquestador:** PM (`agents/pm.md`) — no marca una story como `done` si falla algún gate.

---

## 1. Definition of Done (DoD) — global

Una story/task está `done` **solo si** cumple TODOS los criterios. QA verifica y reporta el check-list DoD por story.

| # | Criterio | Evidencia requerida |
|---|----------|---------------------|
| 1 | Código pasa lint sin errores | Output del linter (0 errores) |
| 2 | Build verde | Output del build (exit 0) |
| 3 | Tests pasan (unit + integration + e2e según corresponda) | Output del test runner (0 failures) |
| 4 | Cobertura ≥ 80% (líneas y branches) | Reporte de coverage |
| 5 | Zero vulnerabilidades de severidad alta/crítica | Reporte de dependency audit |
| 6 | Acceptance criteria validados por QA | Check-list AC con evidencia |
| 7 | Code review aprobada — sin findings 🔴 | Receipt de `cavecrew-reviewer` archivado |

> Si un criterio no aplica (p. ej. UI sin e2e), QA lo declara explícitamente como `N/A` con justificación. Silencio ≠ N/A.

### Check-list DoD (formato de reporte QA)

```
DoD — <story-id> <título>
[ ] Lint        — <comando> — PASS/FAIL
[ ] Build       — <comando> — PASS/FAIL
[ ] Tests       — <comando> — N pass / N fail
[ ] Coverage    — XX% lines / XX% branches (umbral 80%)
[ ] Vulns       — 0 high/critical (audit)
[ ] AC          — N/N validados
[ ] Review      — receipt cavecrew-reviewer — sin 🔴
RESULTADO: DONE / NOT DONE
```

---

## 2. Definition of Ready (DoR) — entrada

Una story **no entra** a desarrollo hasta cumplir:

- **Acceptance criteria completos y testables**: cada AC es verificable de forma binaria (pass/fail), sin ambigüedad.
- **Dependencias claras**: dependencias técnicas y de negocio identificadas (stories, servicios, credenciales, contratos de API).
- **Estimación en story points presente**: sin estimación, no se planifica.
- **Criterios de salida definidos**: qué se entrega, cómo se valida y quién valida (QA + PO).

> El PO (`po`) produce el AC; el PM valida DoR antes de delegar. Una story que no cumple DoR vuelve al PO.

---

## 3. Convenciones de código

### Naming
- **Archivos/carpetas:** `kebab-case` (ej. `user-profile.ts`, `payment-service/`).
- **Variables/funciones:** `camelCase`; **clases/tipos/componentes:** `PascalCase`; **constantes:** `UPPER_SNAKE_CASE`.
- **Booleanos:** prefijo `is`/`has`/`should` (ej. `isActive`, `hasAccess`).
- **Sin abreviaturas crípticas.** Nombre = intención.

### Estructura
- Un módulo = una responsabilidad. Separar capas (dominio / aplicación / infraestructura).
- Tests junto al código o en `tests/` espejo, según convención del proyecto.
- No mezclar lógica de negocio con I/O.

### Formato / lint
- Usar el **formatter y linter del proyecto** (Prettier/ESLint, Ruff/Black, gofmt, etc.). No imponer uno nuevo sin ADR.
- Formateo determinístico: el CI falla si `lint` no está limpio.
- Sin código muerto ni `console.log`/`print` de debug en el diff final.

### Commits
- **Conventional Commits** (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Subject ≤ 50 chars, imperativo, sin punto final.
- Cuerpo solo cuando el "por qué" no es obvio.
- Usar el skill **`caveman-commit`** para generar el mensaje.

### Naming de tests
- Patrón: `should <comportamiento esperado> when <condición>`.
- Un test = una aserción de comportamiento (evitar tests multi-propósito).
- Estructura **Arrange / Act / Assert** explícita.
- Tests determinísticos e isolados: sin dependencia de orden, red, reloj real ni estado global compartido.

---

## 4. Gate de code review

**Regla:** todo diff técnico pasa por **`cavecrew-reviewer`** antes de merge. Sin receipt archivado, no hay merge ni `done`.

### Severidades

| Severidad | Significado | Efecto |
|-----------|-------------|--------|
| 🔴 Bloqueante | Bug, riesgo de seguridad, corrupción de datos, rompe contrato/AC | **Bloquea el merge y el `done`.** Debe corregirse. |
| 🟡 Advertencia | Deuda técnica, mantenibilidad, edge case no cubierto | No bloquea merge, pero debe registrarse como issue. |
| 🟢 Nit | Estilo, naming, preferencia menor | Opcional. No bloquea. |

### Flujo
1. Autor termina el diff (DoD local: lint + build + tests).
2. `cavecrew-reviewer` revisa el diff.
3. Reviewer emite findings clasificados por severidad.
4. Si hay 🔴 → autor corrige y se re-revisa (nuevo receipt).
5. Si no hay 🔴 → receipt **archivado** (link/artefacto) y merge permitido.

### Receipt (archivable)
```
REVIEW RECEIPT
Diff: <commit-sha / PR-url>
Reviewer: cavecrew-reviewer
Findings: 🔴 N | 🟡 N | 🟢 N
Veredicto: APPROVED / CHANGES REQUESTED
Fecha: <ISO-8601>
```

---

## 5. Gate de seguridad (pre-release)

Se ejecuta **antes de cada release**. Owner: agente **Security** (`agents/security.md`, a crear). Bloquea el release ante cualquier hallazgo crítico.

| Control | Qué valida | Bloquea release |
|---------|------------|-----------------|
| **Secret-scan** | Sin credenciales, tokens ni API keys en código/historial/`.env` versionado | Sí (cualquier secreto) |
| **Dependency audit** | Sin CVEs de severidad alta/crítica en dependencias | Sí (high/critical) |
| **Authz/Authn review** | Rutas protegidas, roles/permisos correctos, sin IDOR, sin bypass de auth | Sí (cualquier hallazgo) |

### Reglas
- Secretos siempre vía `{env:...}` / variables de entorno — nunca hardcodeados (ver README).
- Toda ruta nueva que exponga datos requiere chequeo explícito de autorización.
- El reporte de seguridad se archiva junto al receipt de review.

### Receipt (archivable)
```
SECURITY RECEIPT
Release: <versión>
Secret-scan: PASS/FAIL
Dependency audit: N high / N critical
Authz/Authn review: PASS/FAIL
Veredicto: APPROVED / BLOCKED
Fecha: <ISO-8601>
```

---

## 6. Integración con el workflow del PM

1. **DoR** valida la entrada de la story.
2. Desarrollo + tests (QA implementa unit/integration/e2e).
3. **Code review gate** (`cavecrew-reviewer`) → sin 🔴.
4. **DoD** verificado por QA → check-list completo.
5. **Security gate** pre-release.
6. Solo entonces el PM mueve el ticket a `done`.

> El PM no marca `done` ni presenta resultados al usuario si algún gate está en rojo.
