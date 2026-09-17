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

## 5. Panel por sprint (formato de salida)

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
Asunciones: <story points poblados? status names? ventana?>
```

## 6. Loop de retro
Al cierre de cada release (`SHIPPED`), Reporting genera el **post-mortem**
(qué falló, causa raíz, acciones con owner y due date) y alimenta `docs/kb/`
(`lessons-learned.md`, siguiendo el formato de `docs/kb/README.md`). Si la
lección implica una regla vinculante, se propone un ADR en `docs/adr/`. Ver el
detalle del proceso en `agents/reporting.md` §Retro loop.
