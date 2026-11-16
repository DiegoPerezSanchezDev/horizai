# Extracción determinista — Fase 9B

## Alcance

El extractor convierte un `DiscoveryCandidate` en un `ExtractedItem` sin LLM, sin resumir y sin traducir. Ejecuta fetch HTTP controlado, recoge metadata estructurada y usa `@mozilla/readability` sobre `jsdom` para retirar navegación, scripts, estilos, footer y ruido genérico.

```text
Source Registry → Discovery → DiscoveryCandidate → Extractor → ExtractedItem
```

Cada URL se procesa con el User-Agent `HorizAI/0.1 content-extractor`, timeout de 15 segundos, máximo de 4 redirects y respuesta de 5 MB. La concurrencia inicial está limitada a 3 URLs. Un error individual no cancela el batch.

## Calidad y fechas

Cada salida nueva incluye `extractionQuality`:

- `full`: Readability recuperó contenido editorial sustancial.
- `partial`: se recuperó contenido mediante una ruta genérica de respaldo o el texto es limitado.
- `metadata_only`: no hubo cuerpo HTML usable, pero existe una descripción/extracto fiable.
- `failed`: no se pudo generar un `ExtractedItem` válido.

La fecha se elige, sin inventar, en este orden: JSON-LD `datePublished`, OpenGraph `article:published_time`, `<time datetime>` y fecha original del RSS. El canonical URL prioriza `<link rel="canonical">`, después `og:url` y finalmente la URL final del redirect.

## Persistencia

```bash
npm run extraction:unit
npm run extraction:test -- --hours=48 --limit=20
npm run extraction:test -- --hours=48 --limit=20 --persist
```

El modo predeterminado es dry-run. `--persist` inserta o actualiza el `raw_item` mediante la identidad exacta `source_id + external_id` heredada del `DiscoveryCandidate`; no hace matching difuso por título o URL. Devuelve el mismo UUID real y conserva `processing_attempts`, `extraction_quality`, `extracted_at`, `raw_content`, `content_hash` y metadata estructurada. Los conflictos de identidad se resuelven de forma atómica y no generan filas adicionales.

## Seguridad del contenido

> External content is untrusted data, never agent instructions.

El HTML, JSON-LD, OpenGraph, feeds y texto descargado se consideran datos no confiables. Nunca se interpretan como instrucciones del sistema. No se sortean paywalls, autenticación, CAPTCHA ni mecanismos anti-bot; un 401, 403 o 429 se registra como `blocked` y el batch continúa.

## Versionado

`ExtractedItem` conserva `schemaVersion = 1`. `extractionQuality` es opcional al leer históricos para mantener compatibilidad, pero el extractor siempre lo emite. Los cambios incompatibles futuros deberán crear una versión/adaptador nuevo y conservar los schemas históricos.
