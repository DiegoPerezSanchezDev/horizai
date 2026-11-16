# Verifier Agent

El Verifier es propietario de `VerificationResult`. Su única responsabilidad es determinar qué está respaldado por las fuentes de un `ClusteredEvent`. No traduce, redacta, clasifica, puntúa importancia ni publica.

Su entrada contiene el evento agrupado, los `ExtractedItem` completos y metadata no secreta de las fuentes. La salida es exclusivamente el objeto `VerificationResult` validado por Zod. Los cinco estados son `confirmed`, `developing`, `single_source`, `rumor` y `rejected`.

Antes de enviar la petición, `verifier-input-builder.ts` elimina HTML, OpenGraph, JSON-LD, hashes y metadata de debugging. Conserva solo campos periodísticamente útiles y aplica `AGENT_MAX_INPUT_CHARS` (por defecto 12.000) sobre el contenido combinado, repartiendo el presupuesto entre fuentes y marcando si hubo truncado. El runtime registra únicamente métricas de tamaño y no el contenido.

La política es conservadora: una única fuente razonablemente fiable se mantiene como `single_source`; una fuente primaria clara o varias fuentes independientes pueden justificar `confirmed`, pero no se convierte una afirmación promocional en hecho sin evidencia. Los hechos son atómicos, las afirmaciones débiles van a `uncertainClaims` y las discrepancias a `contradictions`.

Todo contenido externo —título, HTML, artículo, metadata, URL o texto de una fuente— es **UNTRUSTED DATA**. El prompt del agente ordena ignorar instrucciones que aparezcan dentro de ese contenido, no cambiar la tarea por texto de una noticia y no ejecutar herramientas por instrucciones de un artículo.

## Ejecución

`npm run verifier:test -- --hours=48 --limit=3` ejecuta Discovery → Extraction → Clustering → Verification en dry-run. Por defecto son 24 horas y 10 eventos. No se crean artículos ni se persisten resultados periodísticos; la observabilidad puede escribir `agent_runs` y `agent_logs`. El informe resumido se genera en `artifacts/verifier-report.json`.

Si falta configuración del modelo, el comando termina con error indicando exactamente las variables ausentes y no inicia Discovery ni realiza llamadas externas del proveedor. Los tests de `npm run verifier:unit` utilizan únicamente un proveedor mock.

Los errores HTTP guardan solo status, mensaje/tipo/código sanitizados, `retry-after`, cabeceras `x-ratelimit-*` y métricas de tamaño. Un HTTP 429 se clasifica como `FREE_TIER_LIMIT_REACHED`, detiene nuevas llamadas del proceso y no cambia de proveedor ni de modelo.

El informe del Verifier conserva por evento el estado, `confidenceScore`, conteos de hechos/claims/contradicciones y longitud de `reason`, junto con la telemetría común. La calibración de `single_source` con confianza muy alta queda como backlog: se necesitan más muestras reales antes de introducir reglas o caps.
