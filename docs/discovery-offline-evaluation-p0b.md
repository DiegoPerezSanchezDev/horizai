# Evaluación offline de discovery (P0-b)

Fecha: 2026-11-06. Sin red, sin proveedores, sin Supabase, `persist=false`, sin scheduler ni migraciones. No se modificó código de `lib/`.

Reproducir: `node --experimental-strip-types scripts/discovery-offline-evaluation.mjs` (o `--json`). Corpus en `scripts/fixtures/discovery-offline-corpus-p0b.mjs`.

## Alcance y límites de la medición

- Corpus **sintético**: 10 fuentes (es, en, pt, fr, de, zh, ja, ar, una vacía legítima y una con feed caído) y 28 elementos, con ventana de 48 h y reloj fijo.
- Las etiquetas siguen la política P0-a, **no** el comportamiento actual del código.
- Mide la **lógica** de discovery. **No mide** qué cubre el catálogo real de feeds; eso requiere una captura real con red, que no se hizo y necesita autorización aparte.
- Con 28 elementos no hay significación estadística. Son casos de prueba dirigidos, no una tasa de pérdida de producción.

## Resultados

| Medida | Valor |
| --- | --- |
| Elementos admitidos | 18 de 28 |
| Esperados en ámbito (IA/tecnología) admitidos | 15 de 17 |
| Pérdidas indebidas | **2** |
| Admisiones indebidas de duplicados o inválidos | 0 |
| Fuente vacía tratada como ausencia legítima | Sí |
| Fuente caída aislada sin frenar al resto | Sí |
| Elementos fuera de ámbito que pasan discovery | 3 de 18 (17 %) |
| Admitidos con país de noticia distinto al país asignado | 4 de 18 |

Correctos: ventana temporal, fecha futura, fecha ausente o ilegible, enlace o título ausente, URL no http, duplicado por URL con parámetros de tracking, y los cinco idiomas con escrituras no latinas (zh, ja, ar) cuando la fecha es estándar.

## Hallazgos

**H1 — Pérdida por formato de fecha local (2 casos, ambos con noticia reciente y en ámbito).** `zh-locale-date` («2026年11月5日 09:00») y `ar-locale-date` («الخميس، 5 نوفمبر 2026») se descartan como «sin fecha fiable» porque `Date.parse` no las entiende. Es una pérdida real para fuentes de China y del mundo árabe, justo donde el catálogo ya es escaso. Severidad propuesta: IMPORTANT. Corrección candidata: tratar el formato por idioma o usar un parser de fechas, tras confirmar con feeds reales que estos formatos aparecen en producción; hoy es una hipótesis sobre cómo publican algunos feeds, no un hecho observado.

**H2 — Fecha sin zona horaria.** `ja-no-tz` se admite, pero V8 la interpreta en la zona del servidor. En una máquina con otra zona podría caer dentro o fuera de la ventana. Riesgo bajo; no se midió con otra zona.

**H3 — Discovery no registra la razón de descarte por elemento.** Solo hay contadores (`undatedExcluded`, `invalid`, `duplicateUrls`), y lo que cae fuera de la ventana no se cuenta. Para saber *por qué* se pierde una noticia hay que reconstruirlo desde fuera, como hace este script. Severidad propuesta: IMPORTANT para P1, porque sin ello no se puede auditar la cobertura.

**H4 — Discovery no filtra por tema.** El 17 % de lo admitido en el corpus está fuera de IA y tecnología. Es esperable si el filtrado ocurre más abajo, pero **no se ha verificado** dónde ocurre ni con qué coste en tokens. Si el filtro está en una etapa con modelo, cada elemento ajeno consume capacidad gratuita limitada. Debe medirse en P1 sobre datos reales.

**H5 — País de la noticia ≠ país de la fuente.** Discovery asigna `possibleCountryCode` del país de la fuente. Los 4 casos de noticia sobre otro país quedan con un país distinto del real (p. ej. una fuente brasileña sobre un chip chino queda como BR). La geografía real depende de etapas posteriores (clasificador y geo-resolver). Esta medición no evalúa esas etapas.

**H6 — El catálogo real limita más que la lógica.** Según `docs/discovery.md` hay 11 feeds RSS activos y 4 fuentes en modo manual, mayoritariamente de EE. UU., Reino Unido y España. Es el principal límite de «alcance global», y esta evaluación offline no puede cuantificarlo.

## Clasificación y recomendaciones

| Nivel | Hallazgo | Propuesta |
| --- | --- | --- |
| IMPORTANT | H1 fechas locales | Confirmar con feeds reales; luego corregir en discovery. |
| IMPORTANT | H3 razones de descarte | Registrar razón por elemento. |
| IMPORTANT | H6 catálogo | Ampliar fuentes de Asia, África, Latinoamérica y Oriente Medio, respetando la política de fuentes de P0-a. |
| POLISH | H2 zona horaria | Asumir UTC o descartar si no hay zona. |
| A MEDIR | H4 filtro temático | Medir dónde y a qué coste se filtra. |
| A MEDIR | H5 país | Evaluar clasificador y geo-resolver con fixtures. |

Ninguna corrección se ha implementado. Cada una requiere autorización y, al tocar `lib/`, su propio plan.

## Pendiente

- Captura real de feeds (necesita red y autorización) para medir cobertura real y confirmar H1.
- Fixtures para clasificador y geo-resolver (H5).
- Verificación de `npm run lint` y `npm run build` (ver estado en la entrega).

## Captura real de feeds (2026-11-06 13:06 UTC)

Autorizada por el CEO. Solo lectura: GET a los 11 feeds públicos registrados en `20260912000002_source_registry_fields.sql`, dos pasadas (48 h y 168 h). Sin Supabase, sin `persist`, sin proveedores, sin cuerpos de artículo. Script: `scripts/discovery-live-feed-capture-p0b.mjs`. Es una instantánea de un único momento, no una tendencia.

| Medida | 48 h | 168 h |
| --- | ---: | ---: |
| Feeds que respondieron | 11 de 11 | 11 de 11 |
| Candidatos admitidos | 84 | 118 |
| Por país asignado | US 54, ES 27, GB 3 | US 79, ES 33, GB 6 |
| Por idioma | en 57, es 27 | en 85, es 33 |
| Sin fecha fiable / inválidos | 0 / 0 | 0 / 0 |
| URLs duplicadas | 0 | 0 |

### Lectura

- **H6 confirmado con datos reales:** el 100 % de lo descubierto está en inglés o español, el 64 % (54 de 84) procede de fuentes de EE. UU. y no hay ninguna fuente de Asia, África, Latinoamérica ni Oriente Medio. Con este catálogo, «todos los países» no es alcanzable aunque los modelos funcionen perfectamente.
- **H1 no se observa en estos 11 feeds:** ninguno tuvo elementos sin fecha fiable. El riesgo de formatos de fecha locales es real para fuentes en chino o árabe que aún no están en el catálogo; hoy es una hipótesis, no una pérdida medida. Hay que verificarlo al añadir cada fuente nueva.
- **El volumen de discovery no es el cuello de botella:** unos 84 candidatos en 48 h frente a una capacidad teórica de unos 13 eventos al día con Groq gratuito (cálculo de planificación de una sola muestra). Lo que limita es la capacidad de los modelos y la selección, no encontrar elementos.
- **Límite de la medición:** TechCrunch (20 de 20) y Xataka (26 de 26) admiten todo el contenido del feed. Su feed solo muestra los últimos 20 o 26 elementos, así que el recuento de esas dos fuentes es un mínimo y puede haber más contenido reciente fuera del feed.
- **No medido:** qué parte de esos 84 es realmente de IA y tecnología. Fuentes como Ars Technica, MIT Technology Review o EL PAÍS Tecnología son más amplias que su etiqueta. Esto requiere clasificar contenido y queda para P1.

### Siguiente decisión sobre el catálogo (H6)

Ampliar fuentes es lo que más mueve el objetivo global. Cada fuente nueva debe: tener feed RSS/Atom público, permitir su uso según la política de P0-a, y comprobarse con esta misma captura (fechas y formato) antes de activarse. La lista concreta se propone aparte; no se ha añadido ninguna.

## Fuentes candidatas para ampliar el catálogo (verificación 2026-11-06, solo lectura)

Script: `scripts/discovery-candidate-sources-check-p0b.mjs` (un GET por feed y uno a `/robots.txt`). No se añadió ninguna fuente al catálogo. La comprobación de `robots.txt` es aproximada (solo el grupo `*`). **Los términos de uso de cada fuente no se han revisado**: son una condición previa a activar cualquiera (política P0-a).

| Región | Fuente (país, idioma) | Resultado |
| --- | --- | --- |
| Asia | SCMP Tech (HK, en), The Hindu Sci-Tech (IN, en) | Viva, fechas correctas |
| Asia | ITmedia AI+ (JP, ja), GIGAZINE (JP, ja), ifanr (CN, zh), IT之家 (CN, zh) | Viva, fechas correctas |
| Asia | Nikkei Asia (JP, en) | Responde, pero 50 de 50 elementos sin fecha que el parser reconozca: se perderían todos (causa sin diagnosticar) |
| Asia | Synced (CN, en) | Inactiva: último elemento hace unos 449 días |
| Asia | Tech in Asia | HTTP 403 (bloquea clientes automáticos) |
| LatAm | Xataka México (es), Tecnoblog (BR, pt), Olhar Digital (BR, pt) | Viva |
| LatAm | Canaltech (BR, pt) | Viva, pero `robots.txt` no permite la ruta del feed: excluir |
| LatAm | Xataka Colombia, Xataka Argentina | Inactivas: unos 310 días sin elementos |
| África | TechCabal (NG, en), ITWeb Africa (ZA, en) | Viva (TechCabal sin `robots.txt` accesible: revisar a mano) |
| África | Disrupt Africa | Inactiva: más de 1.000 días |
| África | Techpoint Africa | HTTP 403 |
| Oriente Medio | Wamda (AE, en) | Responde, pero 20 de 20 sin fecha reconocida: se perderían todos |
| Oriente Medio | MENAbytes, AITNews (ar) | HTTP 403 |
| Oriente Medio | Calcalist Tech | HTTP 404 (URL del feed incorrecta o retirada) |
| Europa | Heise (DE, de), Numerama (FR, fr) | Viva |
| Europa | The Register (GB, en) | Viva, pero `robots.txt` no permite la ruta: excluir |
| Global | Rest of World (en) | Viva, perfil muy alineado con «IA global» |

Conclusiones:
- Hay 15 fuentes viables a falta de revisar términos. Las 403 no se sortean: respetamos el bloqueo.
- **Nikkei Asia y Wamda confirman con datos reales el riesgo H1**: un feed sin fecha reconocible hace que discovery descarte todo su contenido. Antes de activarlos hay que diagnosticar su formato de fecha.
- Casi todas son tecnología general (ofertas, móviles, coches). Con un catálogo más amplio el ruido fuera de IA sube, y el filtro temático (H4) pasa de recomendable a necesario.
- Un arabófono real (AITNews) y la mayoría de Oriente Medio y África quedan flojos; para esas zonas probablemente haga falta otro tipo de fuente (agencias, organismos, blogs de empresas) además de medios.
