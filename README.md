# opencode-agents

Equipo de agentes para **opencode**: PM, PO, Backend, Frontend, Database, Data Analyst, QA, Web Design y DevOps.

## Requisitos

- [opencode](https://opencode.ai) instalado
- Conexión a Ollama con modelos locales (por defecto usa `qwen2.5-coder:7b`)
- API keys para OpenAI, Deepseek y/o GitHub Copilot (según los modelos que quieras usar)

## Instalación

```bash
# Clonar el repo
git clone https://github.com/tu-usuario/opencode-agents.git ~/opencode-agents

# Crear symlinks para que opencode los detecte
ln -s ~/opencode-agents/agents   ~/.config/opencode/agents
ln -s ~/opencode-agents/commands ~/.config/opencode/commands

# (Opcional) Ya existentes, solo actualizar
cd ~/opencode-agents && git pull
```

## Configuración de API Keys

Edita `~/.config/opencode/config.json` y reemplaza los placeholders:

```json
{
  "openai": {
    "options": { "apiKey": "sk-proj-..." }
  },
  "deepseek": {
    "options": {
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com"
    }
  },
  "copilot": {
    "options": { "apiKey": "github_pat_..." }
  }
}
```

| Provider | Dónde obtener la key |
|----------|----------------------|
| OpenAI | https://platform.openai.com/api-keys |
| Deepseek | https://platform.deepseek.com |
| Copilot | GitHub → Settings → Developer settings → PAT (scopes: `copilot`, `read:user`) |

También puedes usar variables de entorno en tu shell en vez de hardcodearlas:
```bash
export OPENAI_API_KEY="sk-..."
```

## Agentes disponibles

| Agente | Modo | Modelo | Rol |
|--------|------|--------|-----|
| **PO** | `all` | `gpt-4o` | Define producto, pregunta, refina la visión, documenta en PRD.md |
| **PM** | `primary` | `gpt-4o` | Coordina al equipo, genera backlog, documentación, delega tareas |
| **Backend** | `subagent` | ollama | APIs, lógica de negocio, servidor |
| **Frontend** | `subagent` | ollama | Componentes, UI, estado, API integration |
| **Database** | `subagent` | ollama | Schemas, migraciones, queries, optimización |
| **Data Analyst** | `subagent` | ollama | Análisis, reportes, visualizaciones, insights |
| **QA** | `subagent` | ollama | Diseña e implementa tests (unit, integration, e2e) |
| **Web Design** | `subagent` | ollama | UX/UI, wireframes, design system, styling |
| **DevOps** | `all` | ollama | CI/CD, infraestructura, Docker/K8s, deploys |

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

  → PM + PO definen el Backlog
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
