# PRD: opencode-agents v2 — Dual Platform (OpenCode + Claude Code)

## Product Vision

`opencode-agents` es un equipo de 15 agentes AI especializados (PM, PO, Business, Backend, Frontend, Database, Data Analyst, QA, Web Design, DevOps, Reporting, Architect, Security, Release Manager, Technical Writer) que funciona **seamlessly** tanto en **OpenCode** como en **Claude Code**. El repo es la **single source of truth**: contiene las definiciones canónicas y, con pasos simples de instalación (symlinks o clone), se activa en cualquiera de las dos plataformas.

Además, el equipo se vuelve **observable desde el chat del equipo humano**: un **Team Chat Bridge** publica en un canal de chat (Slack primero, Discord después) los eventos clave del trabajo de los agentes —handoffs entre agentes, inicio/fin de cada agente, resultados de gates y resúmenes de trabajo redactados (sin secretos, diffs ni código)— para que las personas sigan el progreso sin abrir la terminal. **Cada agente publica con su propia identidad** (nombre visible, rol y avatar), de modo que el chat se lee como una conversación entre miembros del equipo.

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

### 6. Team Chat Bridge (`integrations/chat/`)
Integración que publica la actividad del equipo de agentes en el chat del equipo humano.
- **Plataformas**: Slack primero (F1; workspace con permisos de admin disponible para instalar la app), Discord en F2, ambos detrás de un adaptador común.
- **Runtime**: Node.js.
- **Identidad por agente** (núcleo de la feature):
  - Cada agente publica con su propio nombre visible, rol y avatar, definidos en `integrations/chat/identities.json`.
  - F1 (Slack): avatar como emoji vía el scope `chat:write.customize` (override de `username` / `icon_emoji`).
  - F2: avatares como imágenes (URLs de imagen) en Slack y Discord.
- **Eventos**: **solo** handoffs entre agentes, inicio/fin de cada agente y resultados de gates (DoR, review, DoD, security, release). **No** se publican eventos por herramienta (per-tool). Verbosidad por defecto **baja** (configurable).
- **Resúmenes de trabajo**: permitidos, pero **siempre** redactados (sin secretos/tokens/credenciales ni valores de `.env`) y **nunca** con diffs ni código.
- **F1 — Slack outbound vía Claude Code hooks**:
  - Emisor: hooks de Claude Code.
  - Publica handoffs, inicio/fin de agentes, resultados de gates y resúmenes de trabajo redactados.
  - Identidad por agente con emoji (`chat:write.customize`).
- **F2 — Paridad y enriquecimiento**:
  - Adaptador Discord.
  - Emisor como plugin de OpenCode (paridad con Claude Code).
  - Handoffs agrupados en hilos (threads).
  - @mentions a agentes en los mensajes (p. ej. `@reviewer` → `cavecrew-reviewer`, `@qa` → QA, ...).
  - Link-back a Jira (enlace al issue de la story).
  - Canales por story (opcional).
  - Avatares como imágenes.
- **F3 — Inbound bidireccional** (`@agente` en Slack → ejecución headless) — **decisiones abiertas, no implementar hasta resolver**:
  - Hosting del receptor (local vs. servicio expuesto) — *abierto*.
  - Allowlist de usuarios/canales autorizados — *abierto*.
  - Motor de ejecución headless (OpenCode / Claude Code / ambos) — *abierto*.
  - Presupuesto (tokens/costo y rate limits) por ejecución — *abierto*.
  - Requisito previo: threat model y security gate aprobados antes de iniciar F3.
- **Operación**:
  - Bridge **deshabilitado por defecto** (`CHAT_BRIDGE_ENABLED`).
  - Hooks/plugins **no bloqueantes**, con timeout de ≤2s; un fallo del bridge nunca bloquea a los agentes.
  - Configuración vía `.env` (token del bot, canal destino) más `integrations/chat/config.example.json`, sin secretos en el repo.
- **Cambios en configuración de plataformas**: `.claude/settings.json` y `opencode.json` solo reciben cambios **aditivos** (registro de hooks/plugin); no se modifica ni elimina configuración existente. `agents/*.md` no se toca.

## Out of Scope (for MVP)
- Definición de modelos específicos para Claude Code (usa sus propios modelos; los wrappers `.claude/agents/*.md` no definen `model`).
- Sincronización bidireccional de configuraciones entre plataformas.
- Plugins o extensiones más allá de los 15 agentes actuales, **excepto** el Team Chat Bridge (Core Feature 6).
- Plataformas de chat distintas de Slack y Discord (Teams, Mattermost, otras).
- Adjuntos inbound (archivos enviados desde el chat hacia los agentes).
- UI web propia del bridge.
- Inbound F3 hasta que se resuelvan sus decisiones abiertas y pase el security gate.
- Publicación de eventos por herramienta, diffs o código en el chat.

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
├── integrations/
│   └── chat/                  # Team Chat Bridge (Node.js) — layout final según ADR chat-bridge
│       ├── identities.json    # Identidad por agente: nombre, rol, avatar (emoji F1 / URL imagen F2)
│       ├── config.example.json # Config de ejemplo (sin secretos)
│       ├── schema/            # JSON Schemas (eventos, identities, config)
│       ├── emitters/
│       │   ├── claude-code/   # Hooks de Claude Code (F1)
│       │   └── opencode/      # Plugin de OpenCode (F2)
│       ├── adapters/
│       │   ├── slack/         # Adaptador Slack (F1)
│       │   └── discord/       # Adaptador Discord (F2)
│       ├── events/            # Normalización de eventos (handoff, start/finish, gate)
│       ├── redaction/         # Redacción de resúmenes (secretos, sin diffs/código)
│       └── README.md          # Setup del bridge
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
- Team Chat Bridge: el usuario dispone de un workspace de Slack con permisos de admin para crear/instalar la app del bot.
- Team Chat Bridge: Node.js disponible en el entorno donde corren los agentes.
- Team Chat Bridge: los eventos se capturan con hooks de Claude Code (F1) y un plugin de OpenCode (F2), sin modificar `agents/*.md`; `.claude/settings.json` y `opencode.json` solo reciben cambios aditivos.
- Team Chat Bridge: la app de Slack cuenta con el scope `chat:write.customize` para publicar con nombre/avatar por agente.
- Team Chat Bridge: los resúmenes publicados se consideran visibles para todo el canal; por eso la redacción es obligatoria y sin diffs.
- Decisiones abiertas de F3 (inbound): hosting, allowlist, motor de ejecución y presupuesto.

## Success Criteria

1. Un desarrollador puede instalar los agentes en OpenCode con 2 symlinks.
2. Un desarrollador puede instalar los agentes en Claude Code con otros symlinks (o clone).
3. `/po`, `/pm`, `/business`, `/report`, `/devops` funcionan con el mismo comportamiento en ambas plataformas.
4. El PM orquesta al equipo correctamente en ambas plataformas (lee PRD.md, delega, compila).
5. Jira MCP funciona en ambas plataformas con las mismas credenciales.
6. Los archivos de `agents/` no se duplican — `.claude/agents/` solo contiene wrappers mínimos que referencian los archivos canónicos (`agents/<rol>.md`).
7. **(F1)** El Team Chat Bridge publica en Slack, desde Claude Code, los handoffs, inicio/fin de agentes, resultados de gates y resúmenes redactados. **(F2)** Paridad desde OpenCode (plugin) y en Discord.
8. **(F1)** Un handoff aparece en Slack en ≤5s, con el nombre y avatar del agente según `identities.json`.
9. Con verbosidad por defecto (baja) no se publica ningún evento por herramienta.
10. Ningún mensaje publicado contiene secretos, valores de `.env`, diffs ni fragmentos de código (verificado por tests de redacción).
11. El bridge está deshabilitado por defecto (`CHAT_BRIDGE_ENABLED`); los hooks son no bloqueantes (≤2s), y si el bridge o Slack fallan, los agentes continúan sin bloquearse.
12. El bridge se configura solo con variables de entorno (`.env`) y archivos de config sin secretos, y se instala siguiendo `integrations/chat/README.md`.
