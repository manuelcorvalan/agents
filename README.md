# opencode-agents

Equipo de agentes para [opencode](https://opencode.ai): PM, PO, Backend, Frontend, Database, Data Analyst, QA, Web Design y DevOps, con integración MCP vía Jira.

## Requisitos

- [opencode](https://opencode.ai) instalado (`npm i -g opencode-ai` o `brew install anomalyco/tap/opencode`)
- API key de [DeepSeek](https://platform.deepseek.com)
- Token de API de [Atlassian](https://id.atlassian.com/manage/api-tokens) (para el agente PM con Jira)
- [direnv](https://direnv.net) (recomendado para cargar variables de entorno automáticamente)

## Instalación

```bash
# Clonar el repo
git clone https://github.com/tu-usuario/opencode-agents.git ~/opencode-agents

# Crear symlinks para que opencode los detecte
ln -s ~/opencode-agents/agents   ~/.config/opencode/agents
ln -s ~/opencode-agents/commands ~/.config/opencode/commands

# Configurar direnv (carga automática de .env)
cd ~/opencode-agents
cp .env.example .env
# Editar .env con tus API keys
direnv allow .
```

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

### Global (`~/.config/opencode/config.json`)

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

### Proyecto (`opencode.json`)

Contiene la configuración específica del proyecto: agentes, comandos y MCP.

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
  }
}
```

> **Nota:** opencode mergea automáticamente `~/.config/opencode/config.json` (global) con `opencode.json` (proyecto). Lo global define providers/modelos; lo del proyecto define MCP, agentes y comandos.

## MCP — Jira

El [servidor MCP de Jira](https://github.com/nexus2520/jira-mcp-server) expone herramientas (`jira_issues`, `jira_search`, `jira_comments`, etc.) que el agente PM puede usar para gestionar el backlog, crear issues, buscar y actualizar tareas sin salir del terminal.

Habilitado solo para el agente **PM** vía `config.json`:

```json
"agent": {
  "pm": {
    "tools": {
      "jira_*": true
    }
  }
}
```

Para regenerar el token de API: [https://id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens)

## Agentes disponibles

| Agente | Modo | Modelo | Rol |
|--------|------|--------|-----|
| **PO** | `all` | `deepseek-v4-flash` | Define producto, pregunta, refina la visión, documenta en PRD.md |
| **PM** | `primary` | `deepseek-v4-flash` | Coordina al equipo, genera backlog, documentación, delega tareas |
| **Backend** | `subagent` | `deepseek-v4-flash` | APIs, lógica de negocio, servidor |
| **Frontend** | `subagent` | `deepseek-v4-flash` | Componentes, UI, estado, API integration |
| **Database** | `subagent` | `deepseek-v4-flash` | Schemas, migraciones, queries, optimización |
| **Data Analyst** | `subagent` | `deepseek-v4-flash` | Análisis, reportes, visualizaciones, insights |
| **QA** | `subagent` | `deepseek-v4-flash` | Diseña e implementa tests (unit, integration, e2e) |
| **Web Design** | `subagent` | `deepseek-v4-flash` | UX/UI, wireframes, design system, styling |
| **DevOps** | `all` | `deepseek-v4-flash` | CI/CD, infraestructura, Docker/K8s, deploys |

> `all` = usable como agente primario (tú) y como subagente (vía PM).

## Comandos

| Comando | Descripción |
|---------|-------------|
| `/po` | Interactúa con el Product Owner para definir la visión del producto |
| `/pm` | Invoca al PM para coordinar el equipo y ejecutar el proyecto |
| `/devops` | Da instrucciones directas de deploy e infraestructura |

## Flujo de trabajo recomendado

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
  → Tú apruebas
  → PM delega a los agentes técnicos
  → Los técnicos colaboran entre sí autónomamente
  → QA diseña e implementa tests
  → PM compila el resultado + documentación

FASE 3 — Deploy (cuando tú decidas):
  /devops Desplegar a producción

  → DevOps ejecuta el deploy
```

## Agregar un nuevo agente

1. Crear archivo en `agents/<nombre>.md`
2. Definir frontmatter con `description`, `mode` y `model`
3. Si quieres un comando, crear archivo en `commands/<nombre>.md` con `agent: <nombre>`
4. Opcional: agregarlo al equipo del PM editando `agents/pm.md`
5. Reiniciar opencode

## Mantenimiento

```bash
cd ~/opencode-agents
git pull          # actualizar agentes
git status        # ver cambios locales
git add -A && git commit -m "..." && git push   # publicar cambios
```

## Estructura del proyecto

```
opencode-agents/
├── .env                 # Credenciales (no versionado)
├── .env.example         # Template de variables de entorno
├── .gitignore
├── config.json          # Provider DeepSeek + modelos
├── opencode.json        # MCP Jira + config del proyecto
├── README.md
├── agents/              # Definiciones de agentes
├── commands/            # Comandos personalizados
└── AGENTS.md            # Instrucciones generadas por /init
```
