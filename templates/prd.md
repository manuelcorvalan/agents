<!--
  TEMPLATE CANÓNICO: Product Requirements Document (PRD)
  Fuente: templates/prd.md — software factory opencode-agents
  Owner: PO (agents/po.md)
  Uso: copiar, reemplazar placeholders <...>, borrar comentarios <!-- --> antes de commitear.
-->

# PRD: <nombre-del-producto>

## Product Vision

<!-- 1-3 frases. Qué es, para quién, qué problema resuelve. Visión única y memorable. -->
<Descripción clara de la visión del producto.>

## Target Users

<!-- Lista de usuarios objetivo. Para cada uno: quién es, necesidad principal, contexto. -->
- <Usuario 1 — quién es y qué necesita>
- <Usuario 2 — ...>
- <Usuario N — ...>

## Core Features (MVP)

<!-- Solo lo imprescindible para validar la hipótesis. Numeradas, accionables. -->
### 1. <Feature 1>
<Descripción breve + qué valor aporta al usuario.>

### 2. <Feature 2>
<...>

### N. <Feature N>
<...>

## Out of Scope (for MVP)

<!-- Qué NO se construye ahora. Explícito para frenar scope creep. -->
- <Ítem fuera de alcance 1>
- <Ítem fuera de alcance 2>
- <...>

## Technical Architecture

<!-- Stack, componentes, diagrama de bloques/árbol. Dónde vive cada pieza. -->
```
<Diagrama de arquitectura o estructura de directorios>
```

## Assumptions & Constraints

<!-- Supuestos técnicos y de negocio. Restricciones (presupuesto, plataforma, tiempo, compliance). -->
- <Supuesto / restricción 1>
- <Supuesto / restricción 2>
- <...>

## Success Criteria

<!-- Medibles y verificables. Numeradas. Cada una binaria (cumple/no cumple). -->
1. <Criterio de éxito 1 — medible>
2. <Criterio de éxito 2 — medible>
3. <Criterio de éxito N — medible>

---

<!-- Checklist pre-entrega del PO:
  [ ] Visión definida y validada con el usuario
  [ ] Target users identificados
  [ ] MVP scope acotado (out of scope explícito)
  [ ] Arquitectura coherente con el stack del repo
  [ ] Assumptions y constraints documentados
  [ ] Success criteria medibles
  Invocar /pm para pasar a desarrollo.
-->
