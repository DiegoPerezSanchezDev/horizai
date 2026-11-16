# Política de frescura post-extracción

La frescura se evalúa después de Extraction y antes de construir los eventos elegibles. Discovery conserva su filtro RSS/Atom inicial, pero no es suficiente: una página puede revelar una fecha de publicación más antigua durante la extracción.

## Fecha canónica

`resolveContentFreshnessTimestamp` aplica esta prioridad:

1. `publishedAt` válido de Extraction.
2. `discoveredAt` solo si `publishedAt` está ausente.
3. Si ambas fechas faltan, el item queda ineligible.

Una fecha publicada inválida o futura no se sustituye silenciosamente por `discoveredAt`; queda ineligible con una razón explícita. No existe tolerancia de clock skew porque no hay evidencia que la necesite.

La comparación usa un `referenceTime` único por ejecución, normalmente `PipelineRunContext.startedAt`, y una ventana paramétrica `hours`. La frontera es inclusiva: `effectiveFreshnessAt >= referenceTime - hours` y `effectiveFreshnessAt <= referenceTime`.

## Orden de aplicación

```text
Discovery → Extraction → freshness filter → Clustering
                                      → attempt eligibility → ordering → limit
```

Los raw items stale no se eliminan y no crean `pipeline_event_attempts`. Solo se excluyen del material usado para construir eventos de esa ejecución. En clusters multi-source, cada source item se filtra antes del clustering: una fuente stale no rejuvenece otra; una fuente fresca puede formar un evento con el material fresco restante.

El caso de OpenAI demostró la necesidad: RSS entregó `2026-09-22`, pero Extraction encontró `2026-09-16` en la página. La fecha efectiva es la de Extraction y el item queda fuera de una ventana de 48 horas.
