<!--
  TEMPLATE CANÓNICO: Runbook (operación)
  Fuente: templates/runbook.md — software factory opencode-agents
  Owner: DevOps (agents/devops.md)
  Uso: copiar, reemplazar placeholders <...>.
-->

# Runbook: <servicio / release>

- **Servicio**: <nombre>
- **Versión / Release**: <versión>
- **Owner**: <DevOps / equipo>
- **Fecha**: <ISO-8601>

## Deploy

<!-- Pasos exactos, comandos reales, orden. Idempotente y repetible. -->

```bash
# 1. <pre-requisitos / build / artefacto>
<comando>

# 2. <deploy>
<comando>

# 3. <verificación post-deploy>
<comando>
```

## Rollback

<!-- Cómo volver atrás rápido si algo sale mal. Trigger + pasos. -->

- **Trigger**: <cuándo ejecutar rollback — criterio objetivo>
- **Pasos**:
```bash
# 1. <revert a versión anterior>
<comando>

# 2. <verificar restauración>
<comando>
```

## Troubleshooting

<!-- Síntoma → causa probable → acción. Tabla o lista. -->

| Síntoma | Causa probable | Acción |
|---------|----------------|--------|
| <síntoma 1> | <causa> | <acción / comando> |
| <síntoma 2> | <causa> | <acción / comando> |

## Alertas

<!-- Qué monitorear, umbral, quién recibe, a dónde escalar. -->

| Alerta / métrica | Umbral | Severidad | Escalar a |
|------------------|--------|-----------|-----------|
| <métrica / log> | <umbral> | <info / warn / critical> | <persona / canal / equipo> |

<!--
  Notas DevOps:
  - Actualizar tras cada release (comandos, versión, umbrales).
  - Rollback debe poder ejecutarse sin acceso al autor original.
-->
