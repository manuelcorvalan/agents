<!--
  TEMPLATE CANÓNICO: User Story
  Fuente: templates/user-story.md — software factory opencode-agents
  Owner: PO (agents/po.md) — produce el AC; PM valida DoR antes de delegar.
  Uso: copiar por cada story, reemplazar placeholders <...>.
  DoR (Definition of Ready): la story NO entra a desarrollo si:
    - AC incompletos o no testables
    - dependencias no claras
    - sin estimación (story points)
  Ver STANDARDS.md sección 2 para el DoR completo.
-->

- **ID**: <US-###>
- **Title**: <nombre corto descriptivo>
- **Description**: As a <rol/usuario> I want <funcionalidad> so that <beneficio/valor>
- **Priority**: <High / Medium / Low>
- **Story Points**: <1 / 2 / 3 / 5 / 8 / 13>
- **Dependencies**: <!-- Obligatorio para DoR. N/A si no hay. -->
  - <dependencia técnica o de negocio: story, servicio, credencial, contrato de API>
- **Acceptance Criteria**:

<!-- Cada AC debe ser binario (pass/fail), sin ambigüedad. Formato Given/When/Then. -->

- [ ] AC-1: Given <contexto/estado inicial> When <acción> Then <resultado esperado verificable>
- [ ] AC-2: Given <...> When <...> Then <...>
- [ ] AC-N: <...>

<!--
  Checklist DoR (completar antes de delegar):
  [ ] AC completos y testables (cada uno binario)
  [ ] Dependencias identificadas (o N/A explícito)
  [ ] Estimación en story points presente
  [ ] Criterios de salida claros (qué se entrega, cómo se valida, quién valida: QA + PO)
-->
