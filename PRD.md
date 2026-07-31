# PRD: opencode-agents v2 — Dual Platform (OpenCode + Claude Code)

## Product Vision

`opencode-agents` es un equipo de 9 agentes AI especializados (PM, PO, Backend, Frontend, Database, QA, Web Design, Data Analyst, DevOps) que funciona **seamlessly** tanto en **OpenCode** como en **Claude Code**. El repo es la **single source of truth**: contiene las definiciones canónicas y, con pasos simples de instalación (symlinks o clone), se activa en cualquiera de las dos plataformas.

## Target Users

- Desarrolladores que usan OpenCode y quieren un equipo de agentes predefinido.
- Desarrolladores que usan Claude Code y quieren el mismo equipo de agentes.
- Equipos que transicionan entre plataformas o usan ambas según el proyecto.

## Core Features (MVP)

### 1. Definiciones canónicas de agentes (`agents/`)
- 9 agentes definidos en `agents/*.md` (formato OpenCode con frontmatter YAML).
- El `.claude/CLAUDE.md` referencia estos mismos archivos en lugar de duplicar definiciones.

### 2. Comandos slash para ambas plataformas
- **OpenCode**: `commands/po.md`, `commands/pm.md`, `commands/devops.md`
- **Claude Code**: `.claude/commands/po.md`, `.claude/commands/pm.md`, `.claude/commands/devops.md`
- Mismo comportamiento: `/po` → PO, `/pm` → PM, `/devops` → DevOps.

### 3. PM orquestador (mismo comportamiento en ambas)
- En **OpenCode**: PM es un agente `primary` que usa `task()` para delegar a subagentes.
- En **Claude Code**: PM se ejecuta como el Claude principal (rol de PM) delegando a subagentes built-in via `task()` con `subagent_type`.
- Flujo idéntico: leer `PRD.md` → delegar al PO el backlog → presentar a usuario → delegar a agentes técnicos → compilar resultados.

### 4. MCP Jira (ambas plataformas)
- OpenCode: vía `opencode.json`
- Claude Code: vía `.claude/settings.json`
- Ambos usan las mismas variables de entorno (`.env`).

### 5. Instalación simple
- README con pasos de instalación para cada plataforma.
- Symlinks desde el repo hacia los paths de configuración de cada herramienta.
- Alternativa: clonar el repo dentro del proyecto.

## Out of Scope (for MVP)
- Definición de modelos específicos para Claude Code (usa sus propios modelos).
- Sincronización bidireccional de configuraciones entre plataformas.
- Plugins o extensiones más allá de los 9 agentes actuales.

## Technical Architecture

```
opencode-agents/
├── agents/                    # Definiciones canónicas (OpenCode nativo)
│   ├── pm.md                  # Product Manager — mode: primary
│   ├── po.md                  # Product Owner — mode: all
│   ├── backend.md             # Backend Developer — mode: subagent
│   ├── frontend.md            # Frontend Developer — mode: subagent
│   ├── database.md            # Database Expert — mode: subagent
│   ├── qa.md                  # QA Expert — mode: subagent
│   ├── web-design.md          # Web Design Expert — mode: subagent
│   ├── data-analyst.md        # Data Analyst — mode: subagent
│   └── devops.md              # DevOps Expert — mode: all
│
├── commands/                  # OpenCode slash commands
│   ├── pm.md
│   ├── po.md
│   └── devops.md
│
├── .claude/                   # Claude Code layer
│   ├── CLAUDE.md              # Instrucciones que referencian agents/
│   ├── commands/              # Claude Code slash commands
│   │   ├── pm.md
│   │   ├── po.md
│   │   └── devops.md
│   └── settings.json          # MCP Jira + config Claude Code
│
├── config.json                # OpenCode: provider DeepSeek + modelos
├── opencode.json              # OpenCode: MCP Jira + config proyecto
├── README.md                  # Instalación dual-platform
├── .env.example
├── .envrc
└── .gitignore
```

## Assumptions & Constraints

- Claude Code tiene agentes built-in equivalentes a los 7 agentes técnicos (`backend`, `frontend`, `database`, `qa`, `web-design`, `data-analyst`, `devops`, `po`). El PM no existe como built-in y se implementa como instrucción en `CLAUDE.md`.
- Los modelos se especifican solo en OpenCode (`config.json`). Claude Code usa sus modelos por defecto.
- Las variables de entorno (`.env`) son compartidas entre ambas plataformas.
- El usuario instalará symlinks manualmente (o clonará el repo en su proyecto).

## Success Criteria

1. Un desarrollador puede instalar los agentes en OpenCode con 2 symlinks.
2. Un desarrollador puede instalar los agentes en Claude Code con otros symlinks (o clone).
3. `/po`, `/pm`, `/devops` funcionan con el mismo comportamiento en ambas plataformas.
4. El PM orquesta al equipo correctamente en ambas plataformas (lee PRD.md, delega, compila).
5. Jira MCP funciona en ambas plataformas con las mismas credenciales.
6. Los archivos de `agents/` no se duplican — `.claude/CLAUDE.md` los referencia.
