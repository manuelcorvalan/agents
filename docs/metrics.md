# docs/metrics.md — Catálogo de KPIs de la software factory

Fuente de verdad de las métricas del equipo. Define **qué** medimos, **cómo** se
calcula, **de dónde** sale el dato, el **target** y la **frecuencia**.

- **Owner:** Reporting (`agents/reporting.md`) — extrae, calcula y publica.
- **Consumidor:** PM (`agents/pm.md`) — usa el panel para decidir y reportar.
- **Relacionado:** `STANDARDS.md` (gates/DoD), `docs/kb/` (retro/post-mortem), `agents/release-manager.md` (cierre de release).

> Convenciones: `PROJ` = project key. Sprint scope vía
> `DURING (startOfSprint(), endOfSprint())` o `sprint in openSprints()/closedSprints()`.
> Los **status names son case-sensitive y localizados** — validar contra el workflow real del proyecto antes de reportar. Si un KPI no se puede calcular, reportar `N/D` + motivo, nunca estimar.

---

## 1. Resumen del catálogo

| KPI | Fórmula (resumen) | Fuente | Target | Frecuencia |
|---|---|---|---|---|
| Throughput (stories) | count stories Done en el sprint | Jira JQL | Trend ↑ / baseline | Por sprint |
| Throughput (story points) | Σ story points de stories Done | Jira JQL | Trend ↑ / baseline | Por sprint |
| Lead time (PRD→prod) | releaseDate(fixVersion) − created(story/PRD) | Jira JQL + versión | ≤ 10 días | Por release |
| Cycle time por fase | avg(entrada fase N+1 − entrada fase N) | Jira changelog | ≤ 2 días/fase | Por sprint |
| First-pass yield (FPY) | 1 − (stories con rework / stories Done) | Jira JQL | ≥ 80% | Por sprint |
| Defectos escapados | count bugs `escaped` creados post-release | Jira JQL | 0 por release | Por release |
| Rework rate | stories devueltas de Review/QA / stories Done | Jira JQL | ≤ 15% | Por sprint |
| Cobertura promedio | avg(line coverage) y avg(branch coverage) | CI coverage report | ≥ 80% | Por sprint |
| Tokens por agente | tokens in/out por agente | skill `caveman-stats` | Trend ↓ / presupuesto | Por sprint |
| Costo por agente | tokens × tarifa (o flat-rate) | `caveman-stats` + billing | Dentro de presupuesto | Por sprint |
| Eventos publicados (bridge) | count ledger `sent` + `sent-unknown` | `.chat-bridge/ledger.jsonl` | Trend ↑ / baseline | Por sprint |
| Tasa de entrega (bridge) | sent / (sent + dead-letter) | ledger + dead-letter | ≥ 99% | Por sprint |
| Dead-letter rate | count dead-letter / (sent + dead-letter) | `.chat-bridge/dead-letter.jsonl` | ≤ 1% y 0 `not_in_channel` | Por sprint |
| Integridad de atribución | receipts relayados / gate.result publicados | `.chat-bridge/bridge.log` | 0 relayados | Por release |
| Fallos de redacción | eventos con `redaction.summary_dropped` | spool + `bridge.log` | 0 secretos publicados | Por release |

---

## 2. KPIs de entrega

### 2.1 Throughput — stories
- **Definición:** cantidad de stories que alcanzan `Done` dentro de la ventana del sprint.
- **Fórmula:** `count(stories con transición a Done durante el sprint)`.
- **Fuente:** Jira JQL.
  ```jql
  project = PROJ AND issuetype = Story
    AND status CHANGED TO Done DURING (startOfSprint(), endOfSprint())
  ```
- **Target:** establecer baseline en el primer sprint y perseguir tendencia creciente sostenida.
- **Frecuencia:** por sprint (al cierre).
- **Owner:** Reporting.

### 2.2 Throughput — story points
- **Definición:** suma de story points de las stories completadas en el sprint.
- **Fórmula:** `Σ storyPoints(stories Done del sprint)`.
- **Fuente:** Jira JQL. Descubrir el field id con `jira_search action=create_metadata` o `jira_issues action=get`; Jira Cloud suele exponerlo como `storyPoints`, si no usar `customfield_XXXXX`.
  ```jql
  project = PROJ AND issuetype = Story
    AND status CHANGED TO Done DURING (startOfSprint(), endOfSprint())
    AND storyPoints IS NOT EMPTY
  ```
- **Target:** trend ↑ / baseline por sprint. **Asunción obligatoria:** indicar si las stories tienen estimación; sin estimación, reportar solo throughput en stories.
- **Frecuencia:** por sprint.
- **Owner:** Reporting.

### 2.3 Lead time (PRD→prod)
- **Definición:** tiempo total desde que se crea la story/PRD hasta que llega a producción (primer release que la incluye).
- **Fórmula:** `releaseDate(fixVersion) − created(story)`; para PRD→prod usar `created(PRD/epic)` como origen.
- **Fuente:** Jira JQL + metadatos de versión.
  ```jql
  project = PROJ AND fixVersion = "vX.Y.Z"
  ```
  Tomar `created` de cada issue y la `releaseDate` de la versión (`jira_issues action=get` / metadata del proyecto).
- **Target:** ≤ 10 días (ajustar por tipo de producto).
- **Frecuencia:** por release.
- **Owner:** Reporting + Release Manager.

### 2.4 Cycle time por fase
- **Definición:** tiempo medio que una story pasa en cada fase del workflow (`To Do → In Progress → In Review → QA → Done`).
- **Fórmula:** por issue, `t(entrada fase N+1) − t(entrada fase N)`; luego promedio por fase.
- **Fuente:** Jira **changelog** (no alcanza con JQL; el JQL solo filtra la cohorte).
  ```jql
  project = PROJ AND status CHANGED TO "In Progress" DURING (startOfSprint(), endOfSprint())
  project = PROJ AND status CHANGED TO "In Review"   DURING (startOfSprint(), endOfSprint())
  project = PROJ AND status CHANGED TO "QA"          DURING (startOfSprint(), endOfSprint())
  ```
  Obtener timestamps con `jira_issues action=get` (changelog/expand).
- **Target:** ≤ 2 días por fase (ajustar); foco en detectar la fase cuello de botella.
- **Frecuencia:** por sprint.
- **Owner:** Reporting.

---

## 3. KPIs de calidad

### 3.1 First-pass yield (FPY)
- **Definición:** % de stories que pasan QA/review al primer intento, sin loop de rework.
- **Fórmula:** `FPY = 1 − (stories con rework / stories Done)`.
- **Fuente:** Jira JQL (cohorte de rework vs cohorte Done).
  ```jql
  -- rework
  project = PROJ AND status CHANGED FROM "In Review" TO "In Progress"
    DURING (startOfSprint(), endOfSprint())
  project = PROJ AND status CHANGED FROM "QA" TO "In Progress"
    DURING (startOfSprint(), endOfSprint())
  ```
- **Target:** ≥ 80%.
- **Frecuencia:** por sprint.
- **Owner:** QA + Reporting.

### 3.2 Defectos escapados a prod
- **Definición:** bugs detectados en producción después de un release, no capturados por QA.
- **Fórmula:** `count(bugs con label escaped creados después de la fecha del release)`.
- **Fuente:** Jira JQL.
  ```jql
  project = PROJ AND issuetype = Bug AND labels = escaped
    AND created >= "<release-date>"
  ```
- **Target:** 0 por release.
- **Frecuencia:** por release (ventana de observación post-deploy).
- **Owner:** QA + Reporting.

### 3.3 Rework rate
- **Definición:** % de stories devueltas desde review/QA a desarrollo (incluye reaperturas).
- **Fórmula:** `stories devueltas / stories Done` (misma cohorte del sprint).
- **Fuente:** Jira JQL.
  ```jql
  project = PROJ AND status CHANGED FROM "In Review" TO "In Progress"
    DURING (startOfSprint(), endOfSprint())
  project = PROJ AND status CHANGED FROM "QA" TO "In Progress"
    DURING (startOfSprint(), endOfSprint())
  project = PROJ AND resolution CHANGED DURING (startOfSprint(), endOfSprint())
  ```
- **Target:** ≤ 15%.
- **Frecuencia:** por sprint.
- **Owner:** Reporting.

### 3.4 Cobertura promedio
- **Definición:** cobertura media de tests (líneas y branches) de las stories mergeadas en el sprint.
- **Fórmula:** `avg(line coverage)` y `avg(branch coverage)` sobre los reportes de coverage de CI.
- **Fuente:** **CI coverage report** (no Jira). El umbral por story vive en `STANDARDS.md` (DoD ≥ 80%).
- **Target:** ≥ 80% líneas y branches.
- **Frecuencia:** por sprint.
- **Owner:** QA + DevOps.

---

## 4. KPIs de costo (tokens)

### 4.1 Tokens por agente
- **Definición:** consumo real de tokens (in/out) por agente dentro del sprint.
- **Fórmula:** lectura directa del session log vía skill **`caveman-stats`** (sin estimación manual).
- **Fuente:** `caveman-stats` (hook mode-tracker). En OpenCode/DeepSeek marcar `N/D` y declarar la plataforma.
- **Target:** tendencia ↓ / dentro del presupuesto por sprint.
- **Frecuencia:** por sprint.
- **Owner:** Reporting.

### 4.2 Costo por agente
- **Definición:** costo monetario estimado del consumo por agente.
- **Fórmula:** `tokens × tarifa del modelo` (DeepSeek, por token) o flat-rate (suscripción Claude Code).
- **Fuente:** `caveman-stats` + billing del proveedor.
- **Target:** dentro del presupuesto definido por sprint.
- **Frecuencia:** por sprint.
- **Owner:** Reporting.

### 4.3 Ahorro por optimización
- **Definición:** tokens ahorrados por las capas de optimización (caveman, RTK, CodeGraph).
- **Fórmula:** diferencia reportada por `caveman-stats` / contadores de RTK y CodeGraph.
- **Fuente:** `caveman-stats` (ver `README.md` §Optimización de tokens).
- **Target:** tendencia ↑ en ahorro sin caída de calidad.
- **Frecuencia:** por sprint.
- **Owner:** Reporting.

---

## 5. KPIs del Team Chat Bridge

Aplican a `integrations/chat/` (ADR-0003, F1 Slack outbound). Todas las fuentes
son archivos locales del proyecto: **no se consulta la API de Slack**.

| Archivo | Contenido |
|---|---|
| `.chat-bridge/ledger.jsonl` | una línea por evento entregado: `{event_id, status, provider, channel, message_ref, sent_at}` |
| `.chat-bridge/dead-letter.jsonl` | una línea por evento no entregado: `{event_id?, reason, error_code, attempts, failed_at}` |
| `.chat-bridge/bridge.log` | `info`/`warn` del sender: `dead_letter <código>`, `gate_relayed:<gate>`, `env_*`, `spool_*` |
| `.chat-bridge/dry-run.log` | payload exacto que se habría publicado (modo dry-run) |

> **Ventana:** el ledger se poda a 30 días y el dead-letter a
> `delivery.dead_letter_ttl_days` (7 por defecto). Reportar ventanas ≤ 7 días o
> el denominador de la tasa de entrega queda incompleto.

### 5.1 Eventos publicados
- **Definición:** eventos que llegaron a Slack, agrupados por `provider` y `channel`.
- **Fórmula:** `count(líneas del ledger con status ∈ {sent, sent-unknown})`.
- **Fuente:** `.chat-bridge/ledger.jsonl`.
- **Target:** trend ↑ / baseline. `sent-unknown` cuenta como publicado: Slack respondió 2xx con body ilegible y no se reintenta para no duplicar.
- **Frecuencia:** por sprint. **Owner:** Reporting.

### 5.2 Tasa de entrega
- **Definición:** proporción de eventos que el sender logró entregar.
- **Fórmula:** `sent / (sent + dead_letter)`.
- **Fuente:** ledger + dead-letter.
- **Target:** ≥ 99%.
- **Asunción:** el denominador son los eventos que llegaron al sender. Un evento que nunca salió del spool (hook sin sender) no aparece en ninguno de los dos archivos.
- **Frecuencia:** por sprint. **Owner:** Reporting.

### 5.3 Dead-letter rate y errores por código
- **Definición:** eventos que quedaron en la cola de descarte y por qué.
- **Fórmula:** `count(dead-letter) / (sent + count(dead-letter))`, agrupado por `error_code`.
- **Fuente:** `.chat-bridge/dead-letter.jsonl`.
- **Target:** ≤ 1%, y **0** entradas con `error_code = not_in_channel` (es configuración, no una falla transitoria).
- **Códigos esperables:** `not_in_channel` (el bot no está en el canal), `invalid_auth` (token revocado), `network_error`, `rotation_leftover`, `invalid_response`.
- **Frecuencia:** por sprint. **Owner:** Reporting.

### 5.4 Duplicados evitados
- **Definición:** eventos descartados por dedup (`event_id` ya entregado).
- **Fórmula:** `N/D` en F1 — el ledger registra lo entregado, no lo descartado.
- **Fuente:** requeriría un contador `deduped` en el sender (F2).
- **Target:** informativo.

### 5.5 Latencia de entrega
- **Definición:** tiempo entre la ocurrencia del evento y su publicación.
- **Fórmula:** `N/D` en F1 — el ledger guarda `sent_at` pero no el timestamp del evento.
- **Fuente:** requeriría persistir `occurred_at` en el ledger (F2).
- **Target:** p95 ≤ 60 s cuando exista la medición.

### 5.6 Integridad de atribución
- **Definición:** receipts de gate publicados por un agente que no es su owner.
- **Fórmula:** `count(bridge.log 'info gate_relayed:<gate>') / count(gate.result publicados)`.
- **Fuente:** `.chat-bridge/bridge.log`.
- **Target:** 0 en condiciones normales. Un valor > 0 significa que un agente publicó un receipt ajeno: se muestra como "Relayed (unverified)" y **no** cuenta como veredicto.
- **Frecuencia:** por release. **Owner:** Security + Reporting.

### 5.7 Fallos de redacción
- **Definición:** eventos cuyo resumen no pasó la redacción y se publicaron solo con metadatos (`redaction.summary_dropped = true`), más cualquier secreto efectivamente publicado.
- **Fórmula:** `count(eventos con summary_dropped) / total`; un secreto publicado es un **incidente**, no un KPI.
- **Fuente:** spool + `.chat-bridge/bridge.log`.
- **Target:** 0 secretos publicados (no negociable). `summary_dropped` es esperado en resúmenes con bloques de código o diffs: el evento sale sin resumen, con metadatos.
- **Frecuencia:** por release. **Owner:** Security.

---

## 6. Panel por sprint (formato de salida)

```
PANEL KPI — Sprint <N> (<inicio> → <fin>) — PROJ <key> — Plataforma <OpenCode|Claude Code>
Throughput:      <n> stories / <sp> SP        target: trend ↑      PASS/FAIL
Lead time:       <d> días (último release)    target: ≤10 días    PASS/FAIL
Cycle time:      To Do <d> | Dev <d> | Review <d> | QA <d>  target: ≤2d/fase
FPY:             <pct>%                        target: ≥80%        PASS/FAIL
Escapados:       <n> (release <tag>)           target: 0           PASS/FAIL
Rework:          <pct>%                        target: ≤15%        PASS/FAIL
Cobertura:       <pct>% lines / <pct>% branches  target: ≥80%      PASS/FAIL
Tokens:          <in>/<out> — costo <$>        (por agente abajo)
Bridge:          <n> publicados | entrega <pct>% | dead-letter <n> (<código>)  target: ≥99% / ≤1%
Asunciones: <story points poblados? status names? ventana?>
```

## 7. Loop de retro
Al cierre de cada release (`SHIPPED`), Reporting genera el **post-mortem**
(qué falló, causa raíz, acciones con owner y due date) y alimenta `docs/kb/`
(`lessons-learned.md`, siguiendo el formato de `docs/kb/README.md`). Si la
lección implica una regla vinculante, se propone un ADR en `docs/adr/`. Ver el
detalle del proceso en `agents/reporting.md` §Retro loop.
