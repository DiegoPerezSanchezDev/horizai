# 12B.1 — Real Content Product Review

**Resultado: READY YES.** Revisión completada el 2026-09-29. No hubo llamadas a proveedores ni escrituras remotas. La evaluación local usó el build de producción y una lectura anónima de la vista pública.

## REAL ARTICLE

- Article: 6203559f-413a-4f06-9346-1720bbeb0e7a
- Event: c5575e04-85fb-4b5e-adbb-b3acc6368c4f
- Slug: openai-emplea-agentes-para-escanear-el-sitio-de-estadisticas-de-la-onu-mas-de-16-000-veces
- Estado: una fila pública encontrada para este slug en public_published_articles; la fase 12A.2 registró el total público en 1.
- Región de presentación: GLOBAL / Global; latitud 20, longitud 0.
- Fuente principal: The Verge AI, URL HTTPS conservada en la vista pública.
- Fecha de publicación: 2026-09-29T20:07:35.132215+00:00.

El artículo público se consultó tal como está publicado. No se editó ni se republicó.

## EDITORIAL REVIEW

**Overall: PASS.** Revisé el titular, resumen, “Por qué importa”, cuerpo, fuente y campos geográficos de la fila pública, junto con el resultado guardado del Critic de 12A.2 (pass, sin issues ni unsupported claims). No hubo una nueva llamada de modelo ni una descarga de la fuente original.

| Comprobación | Estado | Evidencia |
| --- | --- | --- |
| Titular | PASS | Describe los agentes y las más de 16.000 solicitudes; coincide con el resultado editorial persistido. |
| Resumen | PASS | Conserva la fecha de abril a junio de 2026 y presenta como aparente el objetivo de consulta. |
| Por qué importa | PASS | Separa el hecho reportado de su relevancia editorial. |
| Cuerpo | PASS | Una síntesis breve, atribuida a The Verge; “bruteforce” se mantiene como término citado. |
| Fuente | PASS | Un enlace original HTTPS de The Verge AI; la página lo abre en pestaña nueva con relación segura. |
| Cifras y entidades | PASS | 16.000+, abril–junio de 2026, OpenAI, UNCTADstat, UNCTAD y el Índice de Capacidades Productivas concuerdan con los datos editoriales persistidos y la aprobación del Critic. |
| Español | PASS | Texto comprensible y coherente; el anglicismo aparece citado, no como instrucción al lector. |
| Afirmaciones no sustentadas | PASS | El Critic guardado aprobó el texto y no devolvió afirmaciones no sustentadas. La referencia guardada no incluye evidencia por afirmación; no se hizo una segunda comparación directa con el artículo fuente. |

## HOME

La home local devuelve HTTP 200 y presenta el artículo público real. Se reutiliza en el hero, la sección de historias recientes, últimas noticias y el contexto textual del mapa; el mapa tiene una historia ubicada. Es una repetición visible en el modelo de contenido de una portada con una sola noticia, pero cada superficie ofrece un recorrido distinto. La considero una limitación P3 propia de un piloto de una historia, no un bloqueo funcional.

El orden estructural es hero → mapa global → historias recientes → últimas noticias → pie. La página contiene títulos de sección y acceso directo a la noticia. La comprobación de espaciado, colocación visual y overflow en un viewport real quedó limitada porque no se pudo iniciar la automatización del navegador.

## MOBILE 375

**TOOL_LIMITATION.** No se obtuvo una vista de navegador a 375 px; por tanto, no afirmo PASS ni ausencia de overflow. No hay Playwright/Puppeteer instalado ni una suite visual de navegador ya configurada. El lanzamiento local de Chrome headless/CDP fue rechazado por la política de ejecución y no volví a usar Computer Use después de su fallo previo al determinar la URL.

La lectura HTTP del build local y las pruebas de transformación no sustituyen la medida de layout a 375 px. Siguen pendientes el wrapping visual del titular, la composición de hero/mapa/pie y el overflow real.

## MOBILE 390

**TOOL_LIMITATION**, por la misma causa que a 375 px. No se comprobó visualmente el titular, resumen, cuerpo, fuente, metadata, pie ni overflow con viewport 390 px. No se infiere PASS de CSS o de unit tests.

## ARTICLE PAGE

La ruta real local /noticias/openai-emplea-agentes-para-escanear-el-sitio-de-estadisticas-de-la-onu-mas-de-16-000-veces devolvió HTTP 200 con el contenido de la vista pública: un H1, resumen, “Por qué importa”, cuerpo, fecha y fuente original. El artículo tiene H2 para “Por qué importa” y “Fuentes originales”; no necesita un H3 para su estructura actual. El enlace de fuente lleva a la URL HTTPS persistida y usa target=_blank con relación segura.

La fecha aparece en el elemento time como 2026-09-29T20:07:35.132215+00:00. Un slug desconocido devolvió HTTP 404, mostró “Esta noticia no está disponible” y emitió noindex.

## REAL MAP MARKER

**PASS para el contrato de datos del marcador.** La fila pública contiene region_code=GLOBAL, region_latitude=20 y region_longitude=0. La transformación agrupa la ubicación como 20.00000,0.00000; el canvas construye un GeoJSON Point con coordenadas [0,20] (longitud, latitud), una ubicación y una historia. La fase 12A.2 ya había observado localmente el mapa con una historia real ubicada y el enlace de esa historia; este pase reutiliza esa evidencia, y confirma de nuevo la fila pública y la ruta.

El canvas se monta del lado cliente después de que la sección entra en el margen de intersección. En 12B.1 no se midió de nuevo su píxel en una ventana móvil.

## DIRECT MARKER INTERACTION

**TOOL_LIMITATION — interacción directa no verificada.** No se ejecutó un click/tap real sobre el punto ni el click posterior del enlace de la tarjeta.

La ruta funcional determinista sí está revisada: cada feature lleva locationId y storyCount; el handler de MapLibre consulta las capas del punto y pasa el locationId a la selección de ubicación. La ubicación conserva sus historias y la tarjeta seleccionada enlaza la primera historia ordenada a /noticias/<slug>. En el feature no se copia el slug; el enlace sale de la historia asociada a la ubicación. La ruta real del slug devuelve HTTP 200. Esto acredita datos, handler, destino y ruta, pero no convierte el gesto físico en PASS.

## KEYBOARD

**TOOL_LIMITATION para la secuencia Tab/Enter en navegador.** No se ejercitaron teclas reales. La página real incluye un enlace nativo al artículo y el GET de su href resuelve; los enlaces usan estilos focus-visible. El layout también proporciona “Saltar al contenido”. Esto da evidencia estructural de navegación accesible, pero no prueba en esta fase el orden del foco ni la activación con Enter.

## GLOBAL MAP SEMANTICS

La noticia conserva GLOBAL / Global y el centro regional (20, 0). El renderer pasa [longitude, latitude], por lo que el GeoJSON esperado es [0, 20]. El mapa presenta una ubicación y una historia. La vista pública no expone el código de país de clasificación; no se usa ese campo para reinterpretar el punto GLOBAL.

La sección textual adyacente tiene el nombre accesible “Historias ubicadas en el mapa” y mantiene el enlace de la noticia disponible sin seleccionar el punto. El canvas referencia ese contexto mediante aria-describedby.

## ACTIVITY_HISTORY

**Clasificación: EXPECTED_BUT_LATER_AGGREGATION_REQUIRED.**

- La migración inicial define una serie por región, periodo y categoría opcional con activity_score, event_count, article_count, calculation_version y source_run_id; valida los conteos y evita periodos duplicados. El trigger encontrado solo mantiene updated_at.
- Publisher declara activityHistory.operation = none con la razón publication_does_not_recalculate_aggregates; la documentación asigna los agregados a otra etapa. Que Publisher no escriba esta tabla es intencional.
- La búsqueda completa del repositorio no encontró un INSERT, UPDATE, UPSERT, RPC, helper de materialización ni job de agregación. El enum de agent_runs admite aggregate, pero no hay una etapa/agendador de agregación implementada. No se encontró propietario concreto, disparador ni automatización.
- El Ranker acepta historial opcional y calcula momentum con él, pero la llamada del pipeline de producción no pasa activityHistory; sin historial usa momentum=50 y momentumAvailable=false. El checkpoint de este artículo confirma momentum neutral 50 y momentumAvailable=false.
- public_published_articles no selecciona ni une activity_history. El loader, la home, la página de artículo y la transformación/render del mapa tampoco leen esa tabla.

Consecuencias:

- ¿El artículo publicado se muestra incorrectamente por haber 0 filas? **NO.**
- ¿Depende de la tabla public_published_articles? **NO.**
- ¿Depende de ella el mapa actual? **NO.**
- ¿Depende de ella el ranking ya guardado de este artículo? **NO**; usa momentum neutral.
- ¿La funcionalidad futura de momentum/histórico la requiere? **SÍ**; hace falta materialización por periodo y una ruta que suministre esos registros al Ranker.
- ¿Publisher debe escribirla? **NO.** El owner/trigger de la futura etapa sigue sin estar definido en el repositorio. No se implementó remediación ni se hizo una escritura.

El vacío de agregación no bloquea la lectura pública ni el piloto editorial actual. Antes de presentar momentum basado en histórico como señal activa, la siguiente fase correspondiente debe definir dueño, frecuencia/trigger, recálculo idempotente y lectura para Ranker.

## SEO

- Título: **PASS**, “<titular> | HorizAI”.
- Description: **PASS**, coincide con el resumen público.
- Open Graph: **PASS** para og:title, og:description, og:site_name, og:locale, og:type=article y article:published_time.
- Fecha OG: **PASS**, coincide con published_at.
- Canonical: la respuesta local apunta al mismo path de la noticia. Se observa como ruta relativa (/noticias/<slug>), sin inventar un dominio. NEXT_PUBLIC_SITE_URL no está configurado en este entorno, así que el host canónico absoluto de producción es **NOT_DETERMINABLE** aquí.
- Slug desconocido: **PASS**, HTTP 404 con noindex.
- og:image: no está presente; la proyección pública tampoco contiene imagen. El artículo no muestra una imagen sin texto alternativo.

## ACCESSIBILITY

- Home: H1 del hero y H2 de secciones; artículo: un H1 y H2 de contenido/fuentes. No se observó salto de nivel.
- Foco: los links de hero, noticias, panel del mapa y fuente usan estilos focus-visible; la secuencia efectiva de teclado no pudo ejercitarse.
- Enlaces de historias y fuente: anchors con destino real; la fuente externa se abre con relación segura.
- Imágenes: no hay imagen en el contrato público de este artículo, así que no hay imagen sin alt.
- Mapa: el contexto textual está etiquetado y el canvas lo referencia; el panel permite acceder al artículo sin operar el punto. El gesto directo y la navegación por teclado del canvas no se probaron.

## ISSUES

| Severidad | Hallazgo | Estado |
| --- | --- | --- |
| P0 | Ninguno observado. | — |
| P1 | Ninguno observado. | — |
| P2 | Ninguno observado. | — |
| P3 | Con una sola noticia se repite el mismo artículo entre hero, historias recientes, últimas noticias y contexto del mapa; revisar la densidad cuando el piloto alcance tres historias. | Observado, no bloqueante. |
| P3 | No se emite og:image; las tarjetas sociales de este artículo serán textuales mientras el contrato no tenga imagen pública. | Observado, mejora futura. |

Los checks responsive y de interacción que no pudieron ejecutarse se registran como limitaciones de herramienta, no como bugs ni PASS.

## PILOT CONTINUATION DECISION

**CONTINUE_SUPERVISED_PILOT.** El artículo real carga, su contenido pasó el Critic persistido, la navegación por URL y los metadatos principales funcionan, el marker contract es coherente y no hay P0/P1 observado. La ausencia de agregación deja momentum neutral; no daña la noticia, el mapa ni el ranking ya persistido.

## NEXT STEP

Recomiendo **2 publicaciones adicionales** para completar el piloto de tres, secuenciales y supervisadas, sin scheduler. No ejecuté publicaciones. Si se quiere que el producto dependa de momentum histórico, abrir una fase enfocada de agregación antes de prometer esa señal como activa. Mantener pendiente la verificación en navegador de 375/390 px y el click/tap del punto.

## VERIFICATION

Build local servido con npm run start en http://localhost:3000; HTTP 200 para home y artículo; HTTP 404 + noindex para slug desconocido. No se publicó ni desplegó.

Tests offline y checks:

- frontend:public-content:unit — PASS.
- geo:consistency:unit — PASS.
- publisher:unit, publisher:readiness:unit y proyección de payload 12A.1 — PASS.
- critic:unit, critic:checkpoint:unit y sus prechecks deterministas — PASS.
- ranker:unit y agents:contracts:test — PASS.
- pipeline:boundaries:unit — PASS.
- Consulta anónima de la fila real en public_published_articles — PASS.
- Ruta pública real y ruta inexistente — PASS.
- npm run lint — PASS.
- npx tsc --noEmit — PASS.
- npm run build — PASS con Next.js 16.3.4.
- Viewport 375/390, 768/1024/1440, Tab/Enter y click/tap directo del punto — TOOL_LIMITATION.

Provider calls: **0**. Supabase writes: **0**. Cambios de esquema/migraciones/artículos: **0**. Netlify: **NO TOCADO**.

Referencias de implementación: supabase/migrations/20260912000000_initial_schema.sql (tabla y trigger), docs/publisher.md, lib/agents/publisher/publisher-write-plan.ts, lib/agents/pipeline/create-production-pipeline.ts (llamada Ranker sin historial), lib/agents/ranker/rank-signals.ts, supabase/migrations/20260921000014_security_rls_public_read_contract.sql, lib/public-content.ts, components/maps/global-intelligence-map/map-canvas.tsx, components/maps/global-intelligence-map/map-side-panel.tsx, app/noticias/[slug]/page.tsx y app/not-found.tsx.
