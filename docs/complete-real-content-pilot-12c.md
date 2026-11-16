# 12C — Complete Supervised Pilot to 3 Real Publications

**Resultado: publicación objetivo alcanzado (3/3), pero 12C READY: NO.** La revisión humana de la segunda publicación nueva encontró una pérdida material de atribución e incertidumbre respecto de la fuente. Se detuvo cualquier ejecución de proveedores; no se corrigió ni borró ningún registro publicado. El cierre mecánico y técnico está completo, pero el hallazgo factual requiere revisión antes de considerar listo el piloto.

Revisado el 29 de septiembre de 2026. No se hicieron cambios de código ni cambios de esquema para 12C. Se conservaron las modificaciones previas del árbol de trabajo.

## PREFLIGHT

- Se leyó docs/product-principles.md y se siguió OBSERVE → PLAN → EXECUTE → CRITIQUE → VERIFY.
- La inspección inicial confirmó trabajo local anterior de 12A–12B.1. No se sobrescribió ni se hizo commit.
- El conteo público seguro anterior a 12C era **1**: 6203559f-413a-4f06-9346-1720bbeb0e7a, evento c5575e04-85fb-4b5e-adbb-b3acc6368c4f, slug openai-emplea-agentes-para-escanear-el-sitio-de-estadisticas-de-la-onu-mas-de-16-000-veces.
- El registro canónico tenía 2 intentos consumidos de un máximo de 5: intento 1, fallo técnico de Publisher en 12A; intento 2, listo para publicación en la recuperación 12A.2. Ambos cuentan en el presupuesto total del piloto.
- Las migraciones locales y remotas coincidían en 20260927000026. No hay migración 27 ni cambios de esquema.
- El preflight del proveedor confirmó Groq con openai/gpt-oss-20b, maxRetries=0, sin fallback ni router. No se habilitaron scheduler, cola, cron, Netlify ni despliegues.
- Las regresiones obligatorias de proyección del Publisher, geografía, prechecks geográficos de Critic, contrato de PublicationPayload y readiness de Publisher pasaron antes de la ejecución real.

## PILOT BUDGET

| Límite | Antes de 12C | Añadido por 12C | Total al cierre | Restante |
| --- | ---: | ---: | ---: | ---: |
| Artículos reales públicos | 1 | 2 | 3 | Objetivo alcanzado |
| Intentos canónicos de evento (máximo 5) | 2 | 2 | 4 | 1 |
| Solicitudes Groq del piloto (máximo 30) | 7 | 12 | 19 | 11 |

Se procesaron dos eventos, uno a la vez, con seis solicitudes Groq por evento: Verifier, Translator, Editor, Classifier, Ranker y Critic. Las 12 solicitudes se despacharon y liquidaron; reintentos, revisiones adicionales y llamadas desconocidas: 0. El objetivo público llegó a 3 después de la segunda publicación y no se procesó otro candidato.

## CAPACITY BASELINE

Lectura canónica para el día UTC 2026-09-29: 1 solicitud y 2.822 tokens contabilizados; 0 reservas despachadas con uso desconocido; sin bloqueo temporal activo. Límites configurados: 1.000 solicitudes y 200.000 tokens duros; 850 solicitudes y 170.000 tokens blandos; 30 RPM y 8.000 TPM.

El margen blando inicial del día era 849 solicitudes y 167.178 tokens. Una admisión completa de evento proyectaba 6 solicitudes y 12.934 tokens de planificación; la proyección para dos eventos secuenciales era 13 solicitudes y 28.690 tokens, por debajo de los límites blandos. El último encabezado TPM inicial estaba vencido y su reset ya había pasado; para cada etapa posterior se usó únicamente telemetría nueva del proveedor y la política canónica de pacing.

## DISCOVERY

Discovery determinista consultó 15 fuentes activas durante la ventana de 24 horas: 11 tuvieron éxito, 4 quedaron vacías por feed_not_configured y no hubo errores de consulta. Se encontraron 63 elementos; no se detectaron duplicados, elementos inválidos ni fechas ausentes. El segundo recorrido reutilizó los mismos 63 elementos canónicos, sin duplicar la escritura.

## EXTRACTION

Se ejecutó Extraction normal con Readability/jsdom y sus guardas. En el primer recorrido: 57 extracciones completas, 6 bloqueadas y 0 fallidas. En el segundo: 58 completas, 5 bloqueadas y 0 fallidas. No se reprodujeron artículos fuente íntegros; la síntesis editorial y los enlaces siguieron el flujo de producción.

## CLUSTERING

El clustering determinista formó 57 y 58 eventos en los dos recorridos correspondientes. Todos los eventos observados fueron de una sola fuente; hubo 0 eventos multi-fuente y 0 fusiones falsas detectadas. No se inventó corroboración.

## CANDIDATE SELECTION

La selección produjo solo los dos eventos frescos necesarios. Ambos tenían una fuente y se mantuvieron como eventos single_source. Los temas eran distintos de la noticia piloto existente y entre sí. No se fabricó diversidad geográfica ni se modificaron umbrales para forzar publicaciones.

## EVENT 2

- Event key: event-f91a0e775887c720bb2bee5363ce6f26; event ID: d762aa9c-6be6-44f4-9761-ec21323e2722; run: 0327c9a0-1b2b-49a9-b814-351c6ff53b51.
- Fuente única: MIT Technology Review, [publicación original](https://www.technologyreview.com/2026/09/28/1144890/roundtables-the-deadly-failures-of-the-virtual-border-wall/).
- Verifier: single_source, confianza 80. Critic: pass. Una sola fuente siguió representada como tal.
- Ranker: ranking-v1, importancia 50,9. Momentum neutral 50 porque momentumAvailable=false.
- Categoría: investigacion. Región pública: GLOBAL; countryCodes=["US"]; coordenadas canónicas (20, 0).
- Artículo: 7415c685-04ed-4956-a77a-4bc372c9b060, slug mas-de-mil-fallecidos-tras-fallas-en-torres-de-vigilancia-fronteriza.
- Titular público: “Más de mil fallecidos tras fallas en torres de vigilancia fronteriza”.
- Resumen: “Un informe de MIT Technology Review reporta que más de mil personas perdieron la vida al cruzar zonas vigiladas por torres de detección que no lograron identificar ni detenerlas.”
- Por qué importa: “El número elevado de muertes subraya la ineficacia de las medidas de seguridad automatizadas y plantea una urgente necesidad de revisar y mejorar las tecnologías de vigilancia fronteriza.”
- El resumen atribuye la noticia a MIT Technology Review. La página primaria no fue accesible para una comparación completa línea por línea por restricciones de robots/suscripción; no afirmo haberla verificado íntegramente.
- Publisher creó un artículo y un evento, con una fuente, una categoría y dos relaciones; activityRowsCreated=0.
- Uso liquidado: 6 solicitudes y 8.597 tokens. Tras este evento: día UTC 7 solicitudes / 11.419 tokens; 0 desconocidas; margen blando 843 solicitudes / 158.581 tokens; presupuesto del piloto 13/30 llamadas y 3/5 intentos, con 17 llamadas y 2 intentos aún disponibles.

## EVENT 3

- Event key: event-30f226d1b8ba5c9eb8af2b65c46db512; event ID: 5138e509-f4c3-4020-9d13-6a6efac99a39; run: 63b81d9a-e46f-4434-9637-335d3f455e0b.
- Fuente única: TechCrunch AI, [artículo original](https://techcrunch.com/2026/09/28/openai-reportedly-ditches-model-over-safety-concerns/).
- Verifier: single_source, confianza 70. Su razón guardada dice que el artículo cita una fuente que reporta la cancelación y que no había otra confirmación independiente. Critic devolvió pass.
- Ranker: ranking-v1, importancia 45,9. Momentum neutral 50 porque momentumAvailable=false.
- Categoría: modelos. Región pública: US; countryCodes=["US"]; coordenadas (39.8283, -98.5795).
- Artículo: 756b0ee0-b5e6-4153-846f-278a12c9afe3, slug openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad.
- Titular público: “OpenAI suspende el lanzamiento del modelo Astra 6.1 por cuestiones de seguridad”.
- Resumen: “OpenAI ha decidido no lanzar el modelo Astra 6.1, citando preocupaciones de seguridad. La decisión se tomó después de una revisión interna que identificó posibles riesgos asociados con su despliegue.”
- Por qué importa: “La suspensión indica un enfoque cauteloso de OpenAI ante la gestión de riesgos en IA, lo que refuerza la importancia de la supervisión ética antes de publicar tecnología de gran escala.”
- Publisher creó un artículo y un evento, con una fuente, dos entidades, una categoría y cuatro relaciones; activityRowsCreated=0.
- Uso liquidado: 6 solicitudes y 8.250 tokens. Acumulado del día UTC: 13 solicitudes / 19.669 tokens; 0 desconocidas; margen blando 837 solicitudes / 150.331 tokens. Presupuesto del piloto: 19/30 llamadas y 4/5 intentos.
- **Hallazgo factual posterior a publicación:** la fuente de TechCrunch atribuye el reporte al Wall Street Journal y conserva “reportedly”; también indica que TechCrunch contactó a OpenAI para solicitar comentarios. La pieza pública de HorizAI presenta la decisión como confirmada y omite la atribución al WSJ. El resumen además afirma que hubo una revisión interna que identificó riesgos, y el cuerpo asegura que OpenAI concluyó que no podía mitigarlos, afirmaciones que no quedan sustentadas por la fuente tal como está atribuida. Esto convierte una noticia reportada en un hecho corporativo establecido.
- No se editó ni eliminó la noticia publicada. El conteo público ya era 3; se detuvo todo trabajo con proveedores.

## ADDITIONAL FAILED ATTEMPTS IF ANY

No hubo intentos fallidos nuevos en 12C. Los dos intentos previos del evento de The Verge permanecen contabilizados: el primer fallo técnico de Publisher y su recuperación apta para publicación. No se modificaron intentos ni datos de historial.

## PUBLICATIONS

| Artículo | Fuente | Estado editorial | Ubicación |
| --- | --- | --- | --- |
| OpenAI emplea agentes para escanear el sitio de estadísticas de la ONU más de 16.000 veces | The Verge AI | Existente; Critic pass | GLOBAL, (20, 0) |
| Más de mil fallecidos tras fallas en torres de vigilancia fronteriza | MIT Technology Review | Nueva; Critic pass, una fuente | GLOBAL, (20, 0) |
| OpenAI suspende el lanzamiento del modelo Astra 6.1 por cuestiones de seguridad | TechCrunch AI | Nueva; Critic pass, pero hallazgo factual de atribución | US, (39.8283, -98.5795) |

Las tres publicaciones conservan sus URL de fuente, resumen, categoría y campos geográficos públicos. La ausencia de imagen usa el comportamiento de producción vigente y es válida. No se scrapeó ni generó ninguna imagen.

## PUBLIC CONTRACT

La lectura pública segura confirmó el artículo existente antes de empezar, confirmó la publicación MIT antes de iniciar el segundo evento y volvió a confirmar el conteo al llegar a tres tras TechCrunch. Conteos observados: **1 → 2 → 3**. Cada nuevo slug corresponde a una fila pública; el detalle de las tres noticias está disponible y no se publicó dos veces el mismo evento.

## THREE-ARTICLE PRODUCT QA

Se compiló y sirvió el build de producción en localhost, consumiendo datos reales de la vista pública, sin fixtures:

- Home: HTTP 200, 3 rutas de artículo únicas y los tres registros reales.
- Hero: muestra la noticia más reciente según el orden público por fecha. La selección es coherente mecánicamente, aunque ahora el titular Astra hereda el problema de atribución señalado arriba.
- Historias recientes y Últimas noticias: ambas listas muestran los tres artículos, ordenados por fecha. Con tres historias la repetición de la portada de un solo artículo disminuye; cada superficie cumple una función distinta. No apareció un control “Ver más” innecesario, ya que el límite es nueve.
- Las tres rutas de noticias respondieron HTTP 200 y contienen un H1, resumen, “Por qué importa”, cuerpo, categoría y fuente original HTTPS. Los enlaces externos observados usan target=_blank con rel=noopener noreferrer.
- El orden estructural de portada sigue siendo hero → mapa → historias recientes → últimas noticias → pie.
- Cada noticia es de una fuente; la UI no presenta el artículo como corroborado por varias fuentes.
- No se hicieron cambios visuales ni de interfaz durante el piloto.
- **Limitación de herramienta:** no se midieron viewports físicos 375/390 px, tablet o desktop ni se realizaron clicks reales sobre marcadores o recorridos de teclado; se mantienen las limitaciones ya registradas en 12B.1. Se verificaron el HTML servido, las rutas y el contrato de datos; no afirmo una aprobación visual responsive o interacción física.

## MAP

La home muestra **3 artículos publicados, 3 ubicados y 0 sin coordenadas**. El modelo público produce **2 ubicaciones**: (20, 0) agrupa el artículo existente de The Verge y la historia MIT; (39.8283, -98.5795) contiene la historia de TechCrunch. El transformador conserva latitud/longitud y el canvas forma GeoJSON como [longitud, latitud], es decir, [0, 20] y [-98.5795, 39.8283]. Son dos entidades geográficas distintas; MapLibre puede agrupar visualmente los puntos según el zoom. No se estimaron coordenadas adicionales.

## EDITORIAL OBSERVATIONS

Los titulares y categorías son visibles en las tres rutas y la sección “Por qué importa” está presente. La historia MIT atribuye el informe a su fuente, pero la página primaria no se pudo verificar íntegramente desde esta revisión local. El hallazgo que bloquea preparación es el artículo Astra: el registro Verifier advertía explícitamente que no había confirmación independiente, pero la síntesis final perdió el “reportedly” y la atribución al Wall Street Journal. El resultado de Critic (pass) no previno esta pérdida material de incertidumbre. Debe revisarlo una persona antes de valorar la calidad conjunta del piloto.

## ACTIVITY_HISTORY NOTE

Publisher informó activityRowsCreated=0 en ambas publicaciones, como corresponde a su contrato; no se implementó agregación. Las vistas públicas y el mapa no dependen de activity_history. Ranker usó momentum neutral 50 con momentumAvailable=false en los dos eventos nuevos.

## CAPACITY FINAL

- Llamadas Groq nuevas: **12**; tokens reales: **16.847**. Historial: 7 llamadas / 12.703 tokens. Total del piloto: **19 llamadas / 29.550 tokens**.
- Día UTC 2026-09-29: **13 solicitudes / 19.669 tokens**, incluidas las 1 / 2.822 que ya estaban contabilizadas antes de 12C.
- Reservas con uso desconocido: 0. Bloqueo activo: ninguno. Respuestas 429: 0.
- Pacing TPM: 10 decisiones con margen suficiente y 2 esperas exigidas por reset del proveedor (42,347 s y 37,577 s). Sin sleeps aleatorios.
- Margen blando final: **837 solicitudes / 150.331 tokens**. El ledger liquidó todas las solicitudes nuevas.
- Intentos: 4/5; llamadas del piloto: 19/30.

## PILOT LIMITS

Se mantuvo Groq con openai/gpt-oss-20b, concurrencia 1, maxRetries=0, sin fallback y sin revisiones. Hubo 0 llamadas nuevas a Cloudflare, Cerebras, OpenAI API u otros proveedores. No hubo bypass de Publisher, escrituras manuales, cambios de esquema, migración 27, activación de scheduler/router, contacto con Netlify ni deploy. El historial real de eventos, intentos, artículos, relaciones y reservas se conserva.

## ISSUES

1. **Bloqueador de preparación factual (IMPORTANTE):** la publicación Astra elimina la atribución y el carácter provisional que presenta TechCrunch al reportar una nota del WSJ. El artículo afirma como hecho una decisión de OpenAI y detalles de revisión interna que la fuente citada no confirma de manera independiente. Revisar la [fuente original de TechCrunch](https://techcrunch.com/2026/09/28/openai-reportedly-ditches-model-over-safety-concerns/) y el texto público. No se hizo corrección automática.
2. **Limitación de verificación visual:** sin observación de viewport real, clicks del mapa ni recorrido de teclado en esta fase. El HTML y el contrato público sí se comprobaron.
3. **Revisión MIT parcial:** no fue posible contrastar la página primaria completa línea por línea por restricciones de robots/suscripción.
4. activity_history continúa sin etapa de agregación; no bloquea la publicación ni la UI actual.

## NEXT STEP

El objetivo numérico del piloto está completo, pero **no iniciar 12D como aprobación de preparación ni autorizar más publicaciones** hasta que una persona evalúe el texto Astra y decida la corrección editorial canónica. La fase 12D, si se inicia después, debe comenzar sin llamadas a proveedores y revisar conjuntamente las tres historias, la atribución y la preparación de automatización. No se ejecutó 12D automáticamente.

## VERIFY

Todas las suites unitarias offline seleccionadas pasaron, igual que npm run lint, npx tsc --noEmit y el build de producción. El artefacto JSON complementario registra cada prueba y cada límite. La clasificación final sigue siendo **12C READY: NO** por el hallazgo factual, aunque se alcanzó el conteo de tres.
