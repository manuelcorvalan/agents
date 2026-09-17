<!--
  TEMPLATE CANÓNICO: Test Plan
  Fuente: templates/test-plan.md — software factory opencode-agents
  Owner: QA (agents/qa.md)
  Uso: copiar, reemplazar placeholders <...>.
-->

# Test Plan: <story-id / feature>

- **Story / Feature**: <US-### / nombre>
- **Owner**: <quién valida — QA>
- **Entorno**: <dev / staging / prod>
- **Fecha**: <ISO-8601>

## Escenarios

<!-- Un escenario = una condición de comportamiento. Formato Given/When/Then. Numerados. -->

### S1: <nombre del escenario>
- **Given**: <estado inicial / precondición / data de entrada>
- **When**: <acción o input>
- **Then**: <resultado esperado>

### S2: <nombre del escenario>
- **Given**: <...>
- **When**: <...>
- **Then**: <...>

## Data de Test

<!-- Datos, fixtures, mocks, credenciales de test (nunca reales), seeds necesarios. -->
| # | Dato | Valor | Origen |
|---|------|-------|--------|
| 1 | <campo/entidad> | <valor> | <fixture / seed / mock / input manual> |
| 2 | <...> | <...> | <...> |

## Resultados

<!-- Registrar ejecución real. Resultado esperado vs actual por escenario. -->

| Escenario | Resultado esperado | Resultado actual | Estado (PASS/FAIL) |
|-----------|--------------------|------------------|--------------------|
| S1 | <...> | <...> | <PASS / FAIL> |
| S2 | <...> | <...> | <PASS / FAIL> |

## Resumen

- **Total**: <N> escenarios
- **PASS**: <N>
- **FAIL**: <N>
- **Bloqueantes**: <N> (si aplica)

<!--
  Notas QA:
  - Un escenario FAIL con AC asociado → la story NO está done.
  - Registrar evidencia (output del runner, screenshot, log) junto a este plan.
-->
