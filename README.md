# opencode-agents v2 — Dual Platform (OpenCode + Claude Code)

Equipo de 15 agentes AI especializados (PM, PO, Business, Backend, Frontend, Database, QA, Web Design, Data Analyst, DevOps, Reporting, Architect, Security, Release Manager, Technical Writer) que funciona **seamlessly** en [OpenCode](https://opencode.ai) y [Claude Code](https://claude.ai/code). Mismo repo, mismos agentes, dos plataformas.

En OpenCode podés elegir el motor de modelos: **[DeepSeek](#opción-a--deepseek)** (API por token) o **[Claude Code](#opción-b--claude-code-plugin)** (tu suscripción `claude login` vía plugin). En Claude Code los modelos los gestiona la propia herramienta.

## Requisitos

### Para OpenCode

- [OpenCode](https://opencode.ai) instalado (`npm i -g opencode-ai` o `brew install anomalyco/tap/opencode`)
- **Motor de modelos — elegí uno:**
  - **DeepSeek**: API key de [DeepSeek](https://platform.deepseek.com)
  - **Claude Code**: CLI de [Claude Code](https://claude.ai/code) instalado y autenticado (`npm i -g @anthropic-ai/claude-code` + `claude login`) — sin API key, usa tu suscripción
- [RTK](https://github.com/rtk-ai/rtk) — comprime output de comandos bash (~60-90% menos tokens)
- [CodeGraph](https://github.com/colbymchenry/codegraph) — índice de código local para agentes técnicos
- [direnv](https://direnv.net) (recomendado para cargar variables de entorno automáticamente)

### Para Claude Code

- [Claude Code](https://claude.ai/code) instalado
- API key de [DeepSeek](https://platform.deepseek.com)
- Token de API de [Atlassian](https://id.atlassian.com/manage/api-tokens) (para integración Jira)
- [RTK](https://github.com/rtk-ai/rtk) — hook PreToolUse que comprime output de bash
- [CodeGraph](https://github.com/colbymchenry/codegraph) — índice de código local para agentes técnicos
- [direnv](https://direnv.net) (recomendado)

## Instalación — OpenCode

```bash
# Clonar el repo
git clone https://github.com/tu-usuario/opencode-agents.git ~/opencode-agents

# Crear symlinks para que OpenCode los detecte
ln -s ~/opencode-agents/agents   ~/.config/opencode/agents
ln -s ~/opencode-agents/commands ~/.config/opencode/commands

# Configurar direnv (carga automática de .env)
cd ~/opencode-agents
cp .env.example .env
# Editar .env con tus API keys
direnv allow .
```

### Herramientas de optimización de tokens (opcional pero recomendado)

```bash
# RTK — comprime output de comandos bash antes de entrar al contexto del LLM
brew install rtk                     # o: cargo install rtk
rtk init -g --opencode               # plugin para OpenCode (global)
rtk init -g                          # hook PreToolUse para Claude Code

# CodeGraph — índice de código local para agentes técnicos (backend, frontend, qa, architect, database, data-analyst, security)
npm i -g @colbymchenry/codegraph      # o: curl -fsSL .../install.sh | sh
codegraph install -t opencode,claude -l global -y   # wire MCP en ambas plataformas

# Indexar un proyecto (una vez por proyecto; auto-sync después)
cd /ruta/a/tu-proyecto
codegraph init
```

> **RTK** intercepta y reescribe comandos (`git status` → `rtk git status`) reduciendo el output que el agente lee. Instalado global, beneficia a todos los agentes.
> **CodeGraph** construye un knowledge graph del proyecto (símbolos, call paths, blast radius). Indexá cada proyecto donde trabajen los agentes técnicos.

> **Alternativa:** en lugar de symlinks, podés clonar el repo directamente dentro del directorio de tu proyecto y correr `opencode init` desde ahí. OpenCode detecta `agents/` y `commands/` locales automáticamente.

## Instalación — Claude Code

```bash
# Clonar el repo
git clone https://github.com/tu-usuario/opencode-agents.git ~/opencode-agents

# Symlink de .claude/ dentro de tu proyecto
# IMPORTANTE: .claude/ debe estar dentro del working directory del proyecto
ln -s ~/opencode-agents/.claude ~/mi-proyecto/.claude

# Configurar direnv
cd ~/opencode-agents
cp .env.example .env
# Editar .env con tus API keys
direnv allow .
```

> **Importante:** la carpeta `.claude/` debe estar dentro del directorio de trabajo de tu proyecto para que Claude Code la detecte. Las definiciones canónicas viven en `agents/` (single source of truth); `.claude/agents/` contiene solo **wrappers mínimos** que registran cada subagente y apuntan al archivo canónico (`agents/<rol>.md`) — las definiciones **no se duplican**. El orquestador PM de Claude Code lee las definiciones canónicas directamente desde `agents/`.

> Las herramientas de optimización de tokens (RTK + CodeGraph) se instalan una sola vez, en **ambas plataformas** — ver sección **Herramientas de optimización de tokens** más arriba.

## Variables de entorno

Todas las credenciales se cargan desde `.env` usando `{env:...}` en los archivos de configuración. **Nunca se hardcodean secretos en los JSON.**

### Método recomendado: direnv

```bash
# Instalar direnv: https://direnv.net/docs/installation.html
cp .env.example .env          # crear desde template
vi .env                        # completar tus keys
direnv allow .                 # autorizar carga automática
```

El archivo `.env` debe contener:

```bash
# DeepSeek
DEEPSEEK_API_KEY=sk-tu-api-key-aqui

# Jira (agente PM)
JIRA_EMAIL=tu-email@ejemplo.com
JIRA_API_TOKEN=tu-api-token-de-atlassian
JIRA_BASE_URL=https://tu-espacio.atlassian.net

# Context7 (opcional) — docs actualizadas de librerías
# Sin key funciona; la key sube el rate limit. https://context7.com/dashboard
CONTEXT7_API_KEY=
```

### Alternativa: source manual

```bash
set -a && source .env && set +a && opencode
```

## Elegir motor de modelos en OpenCode

OpenCode soporta ambos motores en paralelo. Elegís el que prefieras para cada agente — podés incluso mezclarlos (p. ej. PM en Claude Code, técnicos en DeepSeek).

| | DeepSeek | Claude Code (plugin) |
|---|---|---|
| Config | provider `deepseek` en `~/.config/opencode/config.json` | `"plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"]` |
| Credencial | `DEEPSEEK_API_KEY` en `.env` | ninguna — usa tu `claude login` (Pro/Max, Bedrock, Vertex o API key) |
| Costo | por token (API) | flat-rate de tu suscripción |
| Modelos | `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro` | `claude-code/haiku`, `claude-code/sonnet`, `claude-code/opus` (+ variantes reasoning) |
| Ajuste de agentes | `model: deepseek/...` en `agents/*.md` | `model: claude-code/sonnet` en `agents/*.md` |

> **DeepSeek** es el más económico por token. **Claude Code** da acceso a los modelos Claude sin pagar API, usando tu suscripción. El plugin delega al CLI `claude` como subproceso, por lo que mantiene el sistema de agentes, permisos y MCP de OpenCode.

## Configuración

### OpenCode

#### Opción A — DeepSeek

Global (`~/.config/opencode/config.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "deepseek/deepseek-v4-flash",
  "provider": {
    "deepseek": {
      "options": {
        "apiKey": "{env:DEEPSEEK_API_KEY}",
        "baseURL": "https://api.deepseek.com"
      },
      "models": {
        "deepseek-v4-flash": {
          "limit": { "context": 64000, "output": 8192 },
          "options": { "temperature": 0.2 }
        },
        "deepseek-v4-pro": {
          "limit": { "context": 64000, "output": 8192 },
          "options": { "temperature": 0.0 }
        }
      }
    }
  }
}
```

#### Opción B — Claude Code (plugin)

El plugin [`@khalilgharbaoui/opencode-claude-code-plugin`](https://www.npmjs.com/package/@khalilgharbaoui/opencode-claude-code-plugin) spawns el CLI `claude` como subproceso y registra el provider `claude-code` en OpenCode: agentes, permisos y MCP quedan en OpenCode; la autenticación y facturación usan tu `claude login`.

Config mínima — agregar a `opencode.json` (proyecto) o `~/.config/opencode/opencode.json` (global):

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

Luego reiniciar OpenCode y seleccionar un modelo `claude-code/*` con `/models`.

Overrides opcionales (en `provider.claude-code`):

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "options": {
        "cliPath": "claude",
        "proxyTools": ["Bash", "Edit", "Write", "WebFetch"],
        "bridgeOpencodeMcp": true
      }
    }
  }
}
```

- `cliPath` — ruta al binario `claude` (por defecto `claude` en PATH).
- `proxyTools` — tools built-in de Claude que se enrutan por el executor + UI de permisos de OpenCode (evita que el CLI las ejecute por afuera de OpenCode).
- `bridgeOpencodeMcp` — traduce el bloque `mcp` de tu config de OpenCode al CLI de Claude.
- `accounts` — `["personal", "work"]` expande providers separados por cuenta de Claude.

> **Nota:** para usar el plugin, el CLI de Claude Code debe estar instalado y autenticado: `npm i -g @anthropic-ai/claude-code && claude login`. El plugin **no** requiere `ANTHROPIC_API_KEY`.

#### Proyecto (`opencode.json`)

Contiene la configuración específica del proyecto: MCP y permisos por agente.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "mcp": {
    "jira": {
      "type": "local",
      "command": ["npx", "-y", "@nexus2520/jira-mcp-server"],
      "enabled": true,
      "environment": {
        "JIRA_EMAIL": "{env:JIRA_EMAIL}",
        "JIRA_API_TOKEN": "{env:JIRA_API_TOKEN}",
        "JIRA_BASE_URL": "{env:JIRA_BASE_URL}"
      }
    },
    "context7": {
      "type": "local",
      "command": ["npx", "-y", "@upstash/context7-mcp"],
      "enabled": true,
      "environment": { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" }
    },
    "repomix": {
      "type": "local",
      "command": ["npx", "-y", "repomix", "--mcp"],
      "enabled": true
    },
    "mermaid": {
      "type": "local",
      "command": ["npx", "-y", "mcp-mermaid"],
      "enabled": true
    },
    "excalidraw": {
      "type": "local",
      "command": ["npx", "-y", "mcp-excalidraw-server"],
      "enabled": true
    }
  },
  "agent": {
    "backend":  { "permission": { "codegraph_*": "allow", "context7_*": "allow" } },
    "frontend": { "permission": { "codegraph_*": "allow", "context7_*": "allow" } },
    "qa":       { "permission": { "codegraph_*": "allow", "context7_*": "allow" } },
    "architect":{ "permission": { "codegraph_*": "allow", "context7_*": "allow", "repomix_*": "allow", "mermaid_*": "allow", "excalidraw_*": "allow" } },
    "web-design":{ "permission": { "mermaid_*": "allow", "excalidraw_*": "allow" } },
    "pm":       { "permission": { "codegraph_*": "deny", "repomix_*": "allow", "mermaid_*": "allow", "excalidraw_*": "allow" } }
  }
}
```

> **Nota:** OpenCode mergea automáticamente `~/.config/opencode/config.json` y `~/.config/opencode/opencode.json` (global) con `opencode.json` (proyecto). Lo global define providers/modelos/plugins/MCP; lo del proyecto define MCP y permisos por agente.
> **Importante:** a nivel proyecto solo se leen `opencode.json` / `opencode.jsonc`. Un `config.json` en el proyecto **no se lee** (el soporte de `config.json` es solo para la ruta global `~/.config/opencode/`).

### Claude Code (`.claude/settings.json`)

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "@nexus2520/jira-mcp-server"],
      "env": {
        "JIRA_EMAIL": "${JIRA_EMAIL}",
        "JIRA_API_TOKEN": "${JIRA_API_TOKEN}",
        "JIRA_BASE_URL": "${JIRA_BASE_URL}"
      }
    }
  }
}
```

> Los modelos en Claude Code los gestiona Claude internamente — no se configuran desde este repo.

## MCP — Jira

El [servidor MCP de Jira](https://github.com/nexus2520/jira-mcp-server) expone herramientas (`jira_issues`, `jira_search`, `jira_comments`, etc.) que el agente PM puede usar para gestionar el backlog, crear issues, buscar y actualizar tareas sin salir del terminal.

Habilitado para los agentes **PM** y **Reporting** vía `opencode.json` (OpenCode) y `.claude/settings.json` (Claude Code):

OpenCode:
```json
"agent": {
  "pm": {
    "tools": {
      "jira_*": true
    }
  },
  "reporting": {
    "permission": {
      "jira_*": "allow"
    }
  }
}
```

> Los tools de MCP están disponibles por defecto; el grant explícito a PM/Reporting es opcional. Si se usa, va en `opencode.json` (a nivel proyecto, `config.json` no se lee). Reporting se define como subagente (`mode: subagent`) con los tools `jira_*` habilitados para generar reportes de estado y sprint.

Claude Code: el PM (definido en `.claude/CLAUDE.md`) usa directamente las herramientas MCP expuestas por `settings.json`.

Para regenerar el token de API: [https://id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens)

## MCP — CodeGraph

El servidor MCP de [CodeGraph](https://github.com/colbymchenry/codegraph) (`codegraph serve --mcp`) expone la herramienta `codegraph_explore`: índice local del código (símbolos, call paths, blast radius) en una sola llamada. Se configura globalmente vía `codegraph install`.

Habilitado **solo** para los agentes técnicos Backend, Frontend, QA, Architect, Database, Data Analyst y Security, vía `permission` en `opencode.json`:

```json
"agent": {
  "backend":      { "permission": { "codegraph_*": "allow" } },
  "frontend":     { "permission": { "codegraph_*": "allow" } },
  "qa":           { "permission": { "codegraph_*": "allow" } },
  "architect":    { "permission": { "codegraph_*": "allow" } },
  "database":     { "permission": { "codegraph_*": "allow" } },
  "data-analyst": { "permission": { "codegraph_*": "allow" } },
  "security":     { "permission": { "codegraph_*": "allow" } },
  "pm":           { "permission": { "codegraph_*": "deny" } }
}
```

> **Importante:** los agentes de OpenCode se configuran vía `opencode.json` (o `opencode.jsonc`) a nivel proyecto y global (`~/.config/opencode/opencode.json`). El archivo `config.json` a nivel proyecto **no se lee** (legacy, solo global `~/.config/opencode/config.json` es soportado).
> **Modo symlink:** para enforcement global (agentes en `~/.config/opencode`), espejar el bloque de permisos en `~/.config/opencode/opencode.json`.

## MCP — Context7 (docs actualizadas)

[Context7](https://github.com/upstash/context7) expone `resolve-library-id` y `query-docs`: trae documentación y ejemplos **actualizados y versionados** de cualquier librería directo al contexto del agente. Elimina APIs alucinadas y loops de retry — menos tokens y menos errores.

Habilitado para los agentes técnicos (backend, frontend, database, devops, architect, qa, security). La API key es **opcional** (`CONTEXT7_API_KEY`); sin key funciona con rate limit menor.

```json
"context7": {
  "type": "local",
  "command": ["npx", "-y", "@upstash/context7-mcp"],
  "enabled": true,
  "environment": { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" }
}
```

## MCP — Repomix (empaquetado de repo)

[Repomix](https://github.com/yamadashy/repomix) empaqueta todo el repositorio en un único archivo AI-friendly, útil para planificar sobre codebases grandes o desconocidos sin explorar archivo por archivo.

Habilitado para **Architect**, **Technical Writer** y **PM**.

```json
"repomix": {
  "type": "local",
  "command": ["npx", "-y", "repomix", "--mcp"],
  "enabled": true
}
```

## MCP — Diagramación (Mermaid + Excalidraw)

Dos servidores para producir diagramas como artefactos reales (no descripciones en prosa):

- **[mcp-mermaid](https://github.com/hustcc/mcp-mermaid)** — renderiza y valida Mermaid (flow, sequence, ER, C4-style); exporta `svg`, `png`, `base64` o URL.
- **[mcp-excalidraw-server](https://github.com/yctimlin/mcp_excalidraw)** — canvas Excalidraw en vivo; el agente dibuja, se autocorrige vía screenshots y exporta `.excalidraw` al repo. Ideal para wireframes y flujos hand-drawn.

Habilitados para **Architect**, **Web Design**, **PO**, **PM** y (mermaid) **Technical Writer**.

```json
"mermaid":    { "type": "local", "command": ["npx", "-y", "mcp-mermaid"], "enabled": true },
"excalidraw": { "type": "local", "command": ["npx", "-y", "mcp-excalidraw-server"], "enabled": true }
```

> Los 4 MCPs nuevos suman tool schemas al contexto. Los permisos selectivos por agente (`permission.<server>_*`) aseguran que solo quien los usa cargue esos tools.

## Agentes disponibles

| Agente | Modo | Modelo | Rol |
|--------|------|--------|-----|
| **PO** | `all` | `deepseek-v4-pro` | Define producto, pregunta, refina la visión, documenta en PRD.md |
| **Business** | `all` | `deepseek-v4-pro` | Define el caso de negocio: estrategia, métricas, riesgos, roadmap; documenta en BUSINESS.md |
| **PM** | `primary` | `deepseek-v4-pro` | Coordina al equipo, genera backlog, documentación, delega tareas |
| **Backend** | `subagent` | `deepseek-v4-flash` | APIs, lógica de negocio, servidor |
| **Frontend** | `subagent` | `deepseek-v4-flash` | Componentes, UI, estado, API integration |
| **Database** | `subagent` | `deepseek-v4-flash` | Schemas, migraciones, queries, optimización |
| **Data Analyst** | `subagent` | `deepseek-v4-flash` | Análisis, reportes, visualizaciones, insights |
| **QA** | `subagent` | `deepseek-v4-flash` | Diseña e implementa tests (unit, integration, e2e) |
| **Web Design** | `subagent` | `deepseek-v4-flash` | UX/UI, wireframes, design system, styling |
| **DevOps** | `all` | `deepseek-v4-pro` | CI/CD, infraestructura, Docker/K8s, deploys |
| **Reporting** | `subagent` | `deepseek-v4-flash` | Reportes desde Jira: estado, sprint reviews, analytics |
| **Architect** | `subagent` | `deepseek-v4-pro` | Tech Lead/Architect: ADRs, contratos de módulos, decisiones cross-cutting |
| **Security** | `subagent` | `deepseek-v4-flash` | Threat modeling, secret-scan, dependency audit, gate de seguridad |
| **Release Manager** | `subagent` | `deepseek-v4-flash` | Versionado semver, changelog, release notes, rollback |
| **Technical Writer** | `subagent` | `deepseek-v4-flash` | API docs, runbooks, changelog, setup guides |

> `all` = usable como agente primario (vos) y como subagente (vía PM).  
> La columna **Modelo** aplica al modo DeepSeek. Si elegís el [plugin Claude Code](#opción-b--claude-code-plugin), ajustá `model:` en `agents/*.md` a `claude-code/sonnet` (o `claude-code/haiku` para tareas rápidas, `claude-code/opus` para las más complejas). En Claude Code standalone, los modelos los gestiona la propia herramienta.

## Optimización de tokens

Cinco capas reducen el consumo de tokens, cada una dirigida al agente que más le aprovecha:

| Herramienta | Agentes | Qué comprime | Beneficio |
|---|---|---|---|
| **caveman** | PM (comunicación interna) | Texto generado por el agente (backlog, resúmenes, delegación) | ~65% menos output |
| **RTK** | Todos (global) | Output de comandos bash (`git status`, `grep`, `cat`, tests...) | ~60-90% menos tokens |
| **CodeGraph** | Backend, Frontend, QA, Architect, Database, Data Analyst, Security | Tool calls de exploración de código (call paths, blast radius en 1 llamada) | 69% menos tokens, ~60% menos costo |
| **Context7** | Backend, Frontend, Database, DevOps, Architect, QA, Security | Docs de librerías en vez de APIs alucinadas → menos loops de retry | Menos iteraciones y errores |
| **Repomix** | Architect, Technical Writer, PM | Exploración archivo-por-archivo → un solo archivo empaquetado | Menos tool calls de lectura |

Detalles por herramienta:

- **caveman** — el PM usa estilo terse (skill `caveman`) para la comunicación interna agente↔agente: prompts de delegación y resúmenes de subagentes comprimidos. Los reportes al **usuario** se mantienen en español claro y completo. Configurado en `agents/pm.md` y `.claude/CLAUDE.md`.
- **RTK** — instalado global, reescribe comandos de bash a sus equivalentes comprimidos antes de que el output entre al contexto. No requiere configuración por agente.
- **CodeGraph** — los agentes técnicos consultan el grafo (`codegraph_explore`) antes de modificar código, evitando loops de grep/read. Configurado en `agents/backend.md`, `agents/frontend.md`, `agents/qa.md`, `agents/architect.md`, `agents/database.md`, `agents/data-analyst.md`, `agents/security.md`. Permisos restringidos vía `permission.codegraph_*` en `opencode.json` (deny para el resto de agentes).
- **Context7** — los agentes técnicos consultan docs versionadas (`query-docs`) en vez de inventar APIs. Configurado en los `agents/*.md` técnicos y restringido vía `permission.context7_*`.
- **Repomix** — empaqueta el repo en un archivo para planificar sin explorar. Configurado para Architect/Technical Writer/PM y restringido vía `permission.repomix_*`.

## Comandos

| Comando | OpenCode | Claude Code | Descripción |
|---------|----------|-------------|-------------|
| `/po` | `commands/po.md` | `.claude/commands/po.md` | Interactúa con el Product Owner para definir la visión del producto |
| `/business` | `commands/business.md` | `.claude/commands/business.md` | Define el caso de negocio con el Business Analyst (documenta en BUSINESS.md) |
| `/pm` | `commands/pm.md` | `.claude/commands/pm.md` | Invoca al PM para coordinar el equipo y ejecutar el proyecto |
| `/devops` | `commands/devops.md` | `.claude/commands/devops.md` | Da instrucciones directas de deploy e infraestructura |
| `/report` | `commands/report.md` | `.claude/commands/report.md` | Genera un reporte de estado/sprint desde Jira |

## Arquitectura — qué archivo usa cada plataforma

| Archivo / Directorio | OpenCode | Claude Code |
|---|---|---|
| `agents/*.md` | Directo (definiciones de agentes) | Referenciado por `.claude/CLAUDE.md` |
| `commands/*.md` | Slash commands | — |
| `.claude/CLAUDE.md` | — | PM workflow + referencias a agentes |
| `.claude/agents/*.md` | — | Subagent wrappers (Claude Code) |
| `.claude/commands/*.md` | — | Slash commands |
| `.claude/settings.json` | — | MCP (Jira + context7/repomix/mermaid/excalidraw) |
| `opencode.json` | MCP (Jira + context7/repomix/mermaid/excalidraw) + permisos por agente (codegraph, context7, repomix, mermaid, excalidraw) + plugin claude-code (opcional) | — |
| `~/.config/opencode/opencode.json` | Plugin RTK + MCP (CodeGraph + context7/repomix/mermaid/excalidraw) + plugin claude-code (opcional) + skills caveman + permisos globales (global) | — |
| `~/.config/opencode/AGENTS.md` | Base caveman + guía CodeGraph (global) | — |
| `.env` | Compartido | Compartido |

## Flujo de trabajo recomendado

El flujo es **idéntico en ambas plataformas**. La diferencia está en cómo se ejecuta internamente: OpenCode usa agentes definidos por frontmatter YAML en `agents/*.md`; Claude Code usa `CLAUDE.md` como orquestador PM que delega a subagentes registrados vía wrappers mínimos en `.claude/agents/*.md` (cada wrapper apunta a su archivo canónico `agents/<rol>.md`).

```
FASE 0 — Definir el caso de negocio (opcional):
  /business Quiero lanzar una app de tareas para freelancers

  → Business te hace preguntas estratégicas (modelo de negocio, mercado, KPIs, riesgos)
  → Business guarda el caso en BUSINESS.md

FASE 1 — Definir el producto:
  /po Quiero una app de tareas con login y dashboard

  → PO te hace preguntas, refinan la idea
  → PO guarda la visión en PRD.md
  → PO te dice: "Producto definido, invoca al PM"

FASE 2 — Planificar y construir:
  /pm Ejecutar el proyecto definido en PRD.md

  → PM + PO definen el Backlog (vía Jira)
  → PM te muestra las User Stories para aprobación
  → Tú aprobás
  → PM delega a los agentes técnicos
  → Los técnicos colaboran entre sí autónomamente
  → QA diseña e implementa tests
  → PM compila el resultado + documentación

FASE 3 — Deploy (cuando vos decidas):
  /devops Desplegar a producción

  → DevOps ejecuta el deploy
```

## Software Factory

La software factory integra un pipeline de calidad con **fases y gates** que el PM ejecuta en cada entrega. Fuente de verdad: `STANDARDS.md`.

| Fase | Gate | Owner | Bloquea si |
|------|------|-------|-----------|
| Entrada | DoR (AC testables, deps claras, story points, criterios de salida) | PO define / PM valida | Story no entra a desarrollo |
| Diseño | ADRs + contratos de módulos firmados | Architect | Implementación no arranca |
| Implementación | Code review (`cavecrew-reviewer`) | cavecrew-reviewer | Findings 🔴 |
| Verificación | DoD check-list (lint, build, tests, coverage ≥80%, vulns, AC) | QA | Story no es `done` |
| Pre-release | Security gate (secret-scan, dependency audit, authz/authn) | Security | Release bloqueado |
| Release | Semver + changelog + release notes + rollback | Release Manager (+ Technical Writer para docs) | Sin gates verdes no hay release |

Referencias: `STANDARDS.md` (DoD/DoR/gates), `templates/` (formatos canónicos), `docs/adr/` (decisiones), `docs/metrics.md` (KPIs), `.github/workflows/ci.yml` (pipeline CI), `bin/factory-init` (inicialización).

## Team Chat Bridge

Integración opcional (`integrations/chat/`) que publica en Slack la actividad del equipo de agentes: handoffs, inicio y fin de agentes, resultados de gates (review, DoD, security) y resúmenes redactados. Cada agente aparece con su propio nombre y emoji. En F1 el emisor son hooks de Claude Code (ya registrados en `.claude/settings.json`) y solo hay salida hacia Slack.

- **Apagado por defecto** (`CHAT_BRIDGE_ENABLED`). Cuando lo habilitás, arranca en **dry-run**.
- Los hooks no bloquean: ≤2 s, siempre exit 0, sin stdout. Si el bridge o Slack fallan, los agentes siguen igual.
- No publica diffs, código, prompts ni secretos. El token del bot vive solo en `.env` (`chmod 600`).
- Requiere Node ≥ 22.13 y una app de Slack con scopes `chat:write` + `chat:write.customize`.

Guía completa de instalación, configuración, troubleshooting y modelo de seguridad: **[integrations/chat/README.md](integrations/chat/README.md)**. Diseño: [ADR-0003](docs/adr/0003-chat-bridge.md).

## Estructura del proyecto

```
opencode-agents/
├── .env                    # Credenciales (no versionado)
├── .env.example            # Template de variables de entorno
├── .envrc                  # Config de direnv
├── .gitignore
├── .claude/                # Claude Code layer (v2)
│   ├── CLAUDE.md           # PM orquestador para Claude Code
│   ├── agents/             # Wrappers mínimos — registran subagentes (14)
│   │   ├── po.md
│   │   ├── business.md
│   │   ├── backend.md
│   │   ├── frontend.md
│   │   ├── database.md
│   │   ├── data-analyst.md
│   │   ├── qa.md
│   │   ├── web-design.md
│   │   ├── devops.md
│   │   ├── reporting.md
│   │   ├── architect.md
│   │   ├── security.md
│   │   ├── release-manager.md
│   │   └── tech-writer.md
│   ├── commands/           # Slash commands para Claude Code (5)
│   │   ├── pm.md
│   │   ├── po.md
│   │   ├── business.md
│   │   ├── report.md
│   │   └── devops.md
│   └── settings.json       # MCP (Jira + context7/repomix/mermaid/excalidraw) para Claude Code
├── .github/
│   └── workflows/
│       └── ci.yml          # Pipeline CI (lint + build + tests + secret-scan + audit)
├── agents/                 # Definiciones canónicas de agentes (single source of truth)
│   ├── pm.md
│   ├── po.md
│   ├── business.md
│   ├── reporting.md
│   ├── backend.md
│   ├── frontend.md
│   ├── database.md
│   ├── qa.md
│   ├── web-design.md
│   ├── data-analyst.md
│   ├── devops.md
│   ├── architect.md
│   ├── security.md
│   ├── release-manager.md
│   └── tech-writer.md
├── commands/               # Slash commands para OpenCode
│   ├── pm.md
│   ├── po.md
│   ├── business.md
│   ├── report.md
│   └── devops.md
├── bin/
│   └── factory-init        # Inicializa la estructura de la software factory
├── docs/                   # Documentación de la software factory
│   ├── adr/                # Architecture Decision Records
│   ├── kb/                 # Knowledge base
│   └── metrics.md          # KPIs y métricas
├── integrations/
│   └── chat/               # Team Chat Bridge (Slack, F1) — ver integrations/chat/README.md
├── templates/              # Formatos canónicos de artefactos
│   ├── business-case.md
│   ├── prd.md
│   ├── user-story.md
│   ├── test-plan.md
│   ├── runbook.md
│   └── retro.md
├── STANDARDS.md            # DoD/DoR/convenciones/gates (fuente de verdad de calidad)
├── config.json             # Referencia: provider/modelos/permisos (global ~/.config/opencode/config.json) — no se lee a nivel proyecto
├── opencode.json           # MCP + permisos por agente (OpenCode)
├── .codegraph/             # Índice CodeGraph (generado por `codegraph init`, no versionado)
├── PRD.md                  # Documento de visión del producto
└── README.md
```

## Agregar un nuevo agente

1. Crear archivo en `agents/<nombre>.md`
2. Definir frontmatter con `description`, `mode` y `model`
3. Si querés un comando, crear archivo en `commands/<nombre>.md` (OpenCode) y/o `.claude/commands/<nombre>.md` (Claude Code) con `agent: <nombre>`
4. Agregar el nuevo agente al equipo del PM:
   - OpenCode: editar `agents/pm.md`
   - Claude Code: crear `.claude/agents/<nombre>.md` (wrapper mínimo: frontmatter `name`/`description`/`tools` + "Read `agents/<nombre>.md` first") y editar `.claude/CLAUDE.md` (agregar a la tabla de subagentes y al workflow)
5. Reiniciar la herramienta

## Troubleshooting

### Los agentes no aparecen en OpenCode

```bash
# Verificar que los symlinks apuntan correctamente
ls -la ~/.config/opencode/agents
ls -la ~/.config/opencode/commands

# Si están rotos, recrearlos:
rm ~/.config/opencode/agents ~/.config/opencode/commands
ln -s ~/opencode-agents/agents   ~/.config/opencode/agents
ln -s ~/opencode-agents/commands ~/.config/opencode/commands
```

### Claude Code no detecta .claude/

La carpeta `.claude/` debe estar dentro del working directory de tu proyecto, no en `~/.config/`. Verificá:

```bash
ls ~/mi-proyecto/.claude/CLAUDE.md   # debe existir
```

Si usás symlink, asegurate de que apunte al path correcto:

```bash
ls ~/mi-proyecto/.claude
# Si no existe:
ln -s ~/opencode-agents/.claude ~/mi-proyecto/.claude
```

### Las variables de entorno no se cargan

```bash
# Verificar que direnv está activo
direnv status

# Si no, ejecutar:
cd ~/opencode-agents
direnv allow .
```

### Jira MCP no funciona

```bash
# Probar el servidor MCP manualmente:
npx -y @nexus2520/jira-mcp-server

# Verificar credenciales:
echo $JIRA_EMAIL
echo $JIRA_BASE_URL

# Regenerar el token en: https://id.atlassian.com/manage/api-tokens
```

## Mantenimiento

```bash
cd ~/opencode-agents
git pull          # actualizar agentes
git status        # ver cambios locales
git add -A && git commit -m "..." && git push   # publicar cambios
```
