# opencode-agents v2 — Dual Platform (OpenCode + Claude Code)

Equipo de 9 agentes AI especializados (PM, PO, Backend, Frontend, Database, QA, Web Design, Data Analyst, DevOps) que funciona **seamlessly** en [OpenCode](https://opencode.ai) y [Claude Code](https://claude.ai/code). Mismo repo, mismos agentes, dos plataformas.

## Requisitos

### Para OpenCode

- [OpenCode](https://opencode.ai) instalado (`npm i -g opencode-ai` o `brew install anomalyco/tap/opencode`)
- API key de [DeepSeek](https://platform.deepseek.com)
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

# CodeGraph — índice de código local para agentes técnicos (backend, frontend, QA)
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

> **Importante:** la carpeta `.claude/` debe estar dentro del directorio de trabajo de tu proyecto para que Claude Code la detecte. Los archivos en `agents/` son referenciados por `.claude/CLAUDE.md` — **no se duplican**. El orquestador PM de Claude Code lee las definiciones canónicas directamente desde `agents/`.

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
```

### Alternativa: source manual

```bash
set -a && source .env && set +a && opencode
```

## Configuración

### OpenCode

#### Global (`~/.config/opencode/config.json`)

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
    }
  },
  "agent": {
    "backend":  { "permission": { "codegraph_*": "allow" } },
    "frontend": { "permission": { "codegraph_*": "allow" } },
    "qa":       { "permission": { "codegraph_*": "allow" } },
    "pm":       { "permission": { "codegraph_*": "deny" } }
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

Habilitado para el agente **PM** vía `opencode.json` (OpenCode) y `.claude/settings.json` (Claude Code):

OpenCode:
```json
"agent": {
  "pm": {
    "tools": {
      "jira_*": true
    }
  }
}
```

> Los tools de MCP están disponibles por defecto; el grant explícito a PM es opcional. Si se usa, va en `opencode.json` (a nivel proyecto, `config.json` no se lee).

Claude Code: el PM (definido en `.claude/CLAUDE.md`) usa directamente las herramientas MCP expuestas por `settings.json`.

Para regenerar el token de API: [https://id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens)

## MCP — CodeGraph

El servidor MCP de [CodeGraph](https://github.com/colbymchenry/codegraph) (`codegraph serve --mcp`) expone la herramienta `codegraph_explore`: índice local del código (símbolos, call paths, blast radius) en una sola llamada. Se configura globalmente vía `codegraph install`.

Habilitado **solo** para los agentes técnicos Backend, Frontend y QA, vía `permission` en `opencode.json`:

```json
"agent": {
  "backend":  { "permission": { "codegraph_*": "allow" } },
  "frontend": { "permission": { "codegraph_*": "allow" } },
  "qa":       { "permission": { "codegraph_*": "allow" } },
  "pm":       { "permission": { "codegraph_*": "deny" } }
}
```

> **Importante:** los agentes de OpenCode se configuran vía `opencode.json` (o `opencode.jsonc`) a nivel proyecto y global (`~/.config/opencode/opencode.json`). El archivo `config.json` a nivel proyecto **no se lee** (legacy, solo global `~/.config/opencode/config.json` es soportado).
> **Modo symlink:** para enforcement global (agentes en `~/.config/opencode`), espejar el bloque de permisos en `~/.config/opencode/opencode.json`.

## Agentes disponibles

| Agente | Modo | Modelo | Rol |
|--------|------|--------|-----|
| **PO** | `all` | `deepseek-v4-flash` | Define producto, pregunta, refina la visión, documenta en PRD.md |
| **PM** | `primary` | `deepseek-v4-pro` | Coordina al equipo, genera backlog, documentación, delega tareas |
| **Backend** | `subagent` | `deepseek-v4-flash` | APIs, lógica de negocio, servidor |
| **Frontend** | `subagent` | `deepseek-v4-flash` | Componentes, UI, estado, API integration |
| **Database** | `subagent` | `deepseek-v4-flash` | Schemas, migraciones, queries, optimización |
| **Data Analyst** | `subagent` | `deepseek-v4-flash` | Análisis, reportes, visualizaciones, insights |
| **QA** | `subagent` | `deepseek-v4-flash` | Diseña e implementa tests (unit, integration, e2e) |
| **Web Design** | `subagent` | `deepseek-v4-flash` | UX/UI, wireframes, design system, styling |
| **DevOps** | `all` | `deepseek-v4-flash` | CI/CD, infraestructura, Docker/K8s, deploys |

> `all` = usable como agente primario (vos) y como subagente (vía PM).  
> Los modelos listeados aplican solo a OpenCode. Claude Code usa sus modelos built-in.

## Optimización de tokens

Tres capas reducen el consumo de tokens, cada una dirigida al agente que más le aprovecha:

| Herramienta | Agentes | Qué comprime | Beneficio |
|---|---|---|---|
| **caveman** | PM (comunicación interna) | Texto generado por el agente (backlog, resúmenes, delegación) | ~65% menos output |
| **RTK** | Todos (global) | Output de comandos bash (`git status`, `grep`, `cat`, tests...) | ~60-90% menos tokens |
| **CodeGraph** | Backend, Frontend, QA | Tool calls de exploración de código (call paths, blast radius en 1 llamada) | 69% menos tokens, ~60% menos costo |

Detalles por herramienta:

- **caveman** — el PM usa estilo terse (skill `caveman`) para la comunicación interna agente↔agente: prompts de delegación y resúmenes de subagentes comprimidos. Los reportes al **usuario** se mantienen en español claro y completo. Configurado en `agents/pm.md` y `.claude/CLAUDE.md`.
- **RTK** — instalado global, reescribe comandos de bash a sus equivalentes comprimidos antes de que el output entre al contexto. No requiere configuración por agente.
- **CodeGraph** — los agentes técnicos consultan el grafo (`codegraph_explore`) antes de modificar código, evitando loops de grep/read. Configurado en `agents/backend.md`, `agents/frontend.md`, `agents/qa.md`. Permisos restringidos vía `permission.codegraph_*` en `opencode.json` (deny para el resto de agentes).

## Comandos

| Comando | OpenCode | Claude Code | Descripción |
|---------|----------|-------------|-------------|
| `/po` | `commands/po.md` | `.claude/commands/po.md` | Interactúa con el Product Owner para definir la visión del producto |
| `/pm` | `commands/pm.md` | `.claude/commands/pm.md` | Invoca al PM para coordinar el equipo y ejecutar el proyecto |
| `/devops` | `commands/devops.md` | `.claude/commands/devops.md` | Da instrucciones directas de deploy e infraestructura |

## Arquitectura — qué archivo usa cada plataforma

| Archivo / Directorio | OpenCode | Claude Code |
|---|---|---|
| `agents/*.md` | Directo (definiciones de agentes) | Referenciado por `.claude/CLAUDE.md` |
| `commands/*.md` | Slash commands | — |
| `.claude/CLAUDE.md` | — | PM workflow + referencias a agentes |
| `.claude/commands/*.md` | — | Slash commands |
| `.claude/settings.json` | — | MCP Jira + config |
| `opencode.json` | MCP Jira + permisos por agente (codegraph) | — |
| `~/.config/opencode/opencode.json` | Plugin caveman + RTK + MCP CodeGraph + permisos globales (global) | — |
| `~/.config/opencode/AGENTS.md` | Base caveman + guía CodeGraph (global) | — |
| `.env` | Compartido | Compartido |

## Flujo de trabajo recomendado

El flujo es **idéntico en ambas plataformas**. La diferencia está en cómo se ejecuta internamente: OpenCode usa agentes definidos por frontmatter YAML; Claude Code usa `CLAUDE.md` como orquestador PM que delega a subagentes built-in.

```
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

## Estructura del proyecto

```
opencode-agents/
├── .env                    # Credenciales (no versionado)
├── .env.example            # Template de variables de entorno
├── .envrc                  # Config de direnv
├── .gitignore
├── .claude/                # Claude Code layer (v2)
│   ├── CLAUDE.md           # PM orquestador para Claude Code
│   ├── commands/           # Slash commands para Claude Code
│   │   ├── pm.md
│   │   ├── po.md
│   │   └── devops.md
│   └── settings.json       # MCP Jira para Claude Code
├── agents/                 # Definiciones canónicas de agentes (single source of truth)
│   ├── pm.md
│   ├── po.md
│   ├── backend.md
│   ├── frontend.md
│   ├── database.md
│   ├── qa.md
│   ├── web-design.md
│   ├── data-analyst.md
│   └── devops.md
├── commands/               # Slash commands para OpenCode
│   ├── pm.md
│   ├── po.md
│   └── devops.md
├── config.json             # Referencia: provider/modelos/permisos (global ~/.config/opencode/config.json) — no se lee a nivel proyecto
├── opencode.json           # MCP Jira + permisos por agente (OpenCode)
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
   - Claude Code: editar `.claude/CLAUDE.md` (agregar a la tabla de subagentes y al workflow)
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
