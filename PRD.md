# PRD: opencode-agents v2 — Dual Platform (OpenCode + Claude Code)

## Product Vision

`opencode-agents` es un equipo de 15 agentes AI especializados (PM, PO, Business, Backend, Frontend, Database, Data Analyst, QA, Web Design, DevOps, Reporting, Architect, Security, Release Manager, Technical Writer) que funciona **seamlessly** tanto en **OpenCode** como en **Claude Code**. El repo es la **single source of truth**: contiene las definiciones canónicas y, con pasos simples de instalación (symlinks o clone), se activa en cualquiera de las dos plataformas.

## Target Users

- Desarrolladores que usan OpenCode y quieren un equipo de agentes predefinido.
- Desarrolladores que usan Claude Code y quieren el mismo equipo de agentes.
- Equipos que transicionan entre plataformas o usan ambas según el proyecto.

## Core Features (MVP)

### 1. Definiciones canónicas de agentes (`agents/`)
- 15 agentes definidos en `agents/*.md` (formato OpenCode con frontmatter YAML).
- El `.claude/CLAUDE.md` referencia estos mismos archivos en lugar de duplicar definiciones.

### 2. Comandos slash para ambas plataformas
- **OpenCode**: `commands/pm.md`, `commands/po.md`, `commands/business.md`, `commands/report.md`, `commands/devops.md`
- **Claude Code**: `.claude/commands/pm.md`, `.claude/commands/po.md`, `.claude/commands/business.md`, `.claude/commands/report.md`, `.claude/commands/devops.md`
- Mismo comportamiento: `/pm` → PM, `/po` → PO, `/business` → Business, `/report` → Reporting, `/devops` → DevOps.

### 3. PM orquestador (mismo comportamiento en ambas)
- En **OpenCode**: PM es un agente `primary` que usa `task()` para delegar a subagentes.
- En **Claude Code**: PM se ejecuta como el Claude principal (rol de PM) delegando a subagentes de dominio registrados vía wrappers `.claude/agents/*.md` con `task()` y `subagent_type`.
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
- Definición de modelos específicos para Claude Code (usa sus propios modelos; los wrappers `.claude/agents/*.md` no definen `model`).
- Sincronización bidireccional de configuraciones entre plataformas.
- Plugins o extensiones más allá de los 15 agentes actuales.

## Technical Architecture

```
opencode-agents/
├── agents/                    # Definiciones canónicas (OpenCode nativo)
│   ├── pm.md                  # Product Manager — mode: primary
│   ├── po.md                  # Product Owner — mode: all
│   ├── business.md            # Business Analyst — mode: all
│   ├── backend.md             # Backend Developer — mode: subagent
│   ├── frontend.md            # Frontend Developer — mode: subagent
│   ├── database.md            # Database Expert — mode: subagent
│   ├── qa.md                  # QA Expert — mode: subagent
│   ├── web-design.md          # Web Design Expert — mode: subagent
│   ├── data-analyst.md        # Data Analyst — mode: subagent
│   ├── devops.md              # DevOps Expert — mode: all
│   ├── reporting.md           # Reporting — mode: subagent
│   ├── architect.md           # Architect — mode: subagent
│   ├── security.md            # Security Expert — mode: subagent
│   ├── release-manager.md     # Release Manager — mode: subagent
│   └── tech-writer.md         # Technical Writer — mode: subagent
│
├── commands/                  # OpenCode slash commands (5)
│   ├── pm.md
│   ├── po.md
│   ├── business.md
│   ├── report.md
│   └── devops.md
│
├── .claude/                   # Claude Code layer
│   ├── CLAUDE.md              # Instrucciones que referencian agents/
│   ├── agents/                # Wrappers mínimos — registran subagentes (14)
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
│   ├── commands/              # Claude Code slash commands (5)
│   │   ├── pm.md
│   │   ├── po.md
│   │   ├── business.md
│   │   ├── report.md
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

- Claude Code no tiene subagentes de dominio built-in; los 14 subagentes (PO, Business, Backend, Frontend, Database, Data Analyst, QA, Web Design, DevOps, Reporting, Architect, Security, Release Manager, Technical Writer) se registran vía wrappers mínimos en `.claude/agents/*.md`. El PM no es subagente — se implementa como instrucción en `CLAUDE.md`.
- Los modelos se especifican solo en OpenCode (`config.json`). Claude Code usa sus modelos por defecto.
- Las variables de entorno (`.env`) son compartidas entre ambas plataformas.
- El usuario instalará symlinks manualmente (o clonará el repo en su proyecto).

## Success Criteria

1. Un desarrollador puede instalar los agentes en OpenCode con 2 symlinks.
2. Un desarrollador puede instalar los agentes en Claude Code con otros symlinks (o clone).
3. `/po`, `/pm`, `/business`, `/report`, `/devops` funcionan con el mismo comportamiento en ambas plataformas.
4. El PM orquesta al equipo correctamente en ambas plataformas (lee PRD.md, delega, compila).
5. Jira MCP funciona en ambas plataformas con las mismas credenciales.
6. Los archivos de `agents/` no se duplican — `.claude/agents/` solo contiene wrappers mínimos que referencian los archivos canónicos (`agents/<rol>.md`).
