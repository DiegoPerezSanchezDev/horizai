# 11B — QA visual de contenido y resiliencia del build

Fecha: 2026-09-27 · Next.js 16.3.4 · Resultado: **READY YES**

## BUILD FETCH ROOT CAUSE

`app/page.tsx` llamaba a `getRecentPublishedArticles()` dentro de `HomeContent`. El cliente público de `lib/public-content.ts` usa `fetch` con `cache: "no-store"`, pero esa opción no impedía que Next entrase en el componente y empezara la consulta de Supabase durante la recopilación de páginas. La ruta acababa marcada como dinámica (`ƒ /`), aunque el build aún iniciaba la lectura y registraba un fallo transitorio.

La reproducción previa con `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9` confirmó el fallo. Se añadió `await connection()` antes de la lectura. La guía instalada de Next 16 (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md`) establece que el código posterior a `connection()` espera a una solicitud real. Después del cambio, el build offline terminó sin ningún log de lectura pública; el build normal también terminó correctamente.

## ROUTE RENDERING MODEL

| Ruta | Comportamiento observado | Motivo |
| --- | --- | --- |
| `/` | Dynamic SSR | `connection()` precede a la lectura request-time; las lecturas públicas usan `no-store`. |
| `/noticias/[slug]` | Dynamic SSR | No hay `generateStaticParams`; resuelve el slug y los metadatos al recibir la solicitud. |
| `/contacto`, `/fuentes`, `/metodologia`, `/privacidad`, `/sobre-nosotros`, `/terminos` | Static | Next las prerenderiza durante el build. |
| `/_not-found` | Static | Página de fallback generada por Next. |

No hay ISR ni carga cliente de artículos. El mapa se hidrata en cliente a partir de las historias ya cargadas por el servidor; el navegador solo solicita los tiles del estilo cartográfico configurado.

## BUILD RESILIENCE

**¿Netlify necesita que Supabase esté disponible durante el build? No.** Un build con URL pública sustituida por un endpoint de loopback cerrado (`127.0.0.1:9`) y clave pública ficticia, solo en el proceso, terminó con código 0 y no emitió errores `[public-content]`. El build normal con `.env.local` también pasó. No se editó ningún archivo de entorno.

En producción, la API pública sí debe responder para mostrar noticias actuales. Si falla en runtime, la aplicación conserva el estado `error` y presenta texto de reintento; no convierte el fallo en una portada vacía. En una lectura correcta sin filas conserva `status: "ready"` con `data: []`.

La lectura de la portada queda excluida de la generación estática. En `/noticias/[slug]`, Next no enumera slugs en build y la consulta exacta se hace al atender la ruta.

## FAILURE VS EMPTY

`lib/public-content-result.ts` define resultados `ready` y `error` separados. Las pruebas verifican que ambos estados pueden llevar `[]` sin confundirse. La portada, mapa, destacadas y últimas noticias muestran estados de error distintos del estado vacío; un error de artículo muestra un mensaje de disponibilidad. Los metadatos de error usan un título genérico y no copian datos de una historia.

La unidad de resultado y las ramas de presentación quedaron verificadas. No se llegó a ejecutar un HTTP de runtime con Supabase deliberadamente inaccesible: la revisión automática bloqueó el intento de iniciar `next start` con variables de entorno sustituidas. No se reintentó con otra vía. El build offline sí se comprobó de extremo a extremo y no alcanzó Supabase.

## PUBLIC CREDENTIAL BOUNDARY

La capa `server-only` de lecturas públicas usa `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, con compatibilidad para `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Lee únicamente `public_published_articles`. No importa el cliente de escritura ni usa service role. Una inspección de `.next/static` no encontró marcadores `SUPABASE_SERVICE_ROLE`, `SUPABASE_SECRET_KEY` ni `service_role`.

## FIXTURE ISOLATION

`scripts/frontend-visual-qa-fixtures.ts` conserva cinco historias ficticias originales. Incluye título y resumen largos, una historia breve, imagen SVG `data:` con alt, historia sin imagen, fuentes con dominio reservado `.invalid`, contexto, cuerpo de varios párrafos, categorías y regiones variadas, tres ubicaciones válidas (cuatro historias geolocalizadas), dos historias en las mismas coordenadas y una ficha sin categoría, región ni coordenadas.

Para revisar componentes reales se usaron temporalmente rutas locales con aviso visible y guardia de `NODE_ENV === "development"`. Ambos archivos de ruta se retiraron antes del build final. El cargador público no importa fixtures; las pruebas comprueban que las rutas no existen. El route table final no contiene `/qa-visual`, y las salidas de producción `.next/server` y `.next/static` no contienen el titular ni el slug sintéticos. La ficha sin coordenadas no produce ubicación ni marcador. No existe fallback de fixture en producción.

La ilustración se usa solo en el fixture. El mapper de la vista pública fija `imageUrl` e `imageAlt` en `null` porque el contrato actual de `public_published_articles` no contiene esos campos; no se cambió el esquema.

## HOME POPULATED QA

Se revisaron hero, título largo, resumen, etiquetas, CTA, métricas, callouts, tarjetas destacadas y últimas historias en ambos temas. La imagen local cargó y se recortó con `object-fit: cover`; la tarjeta sin imagen conservó su tratamiento editorial. No se añadieron datos ni imágenes al producto.

La revisión a 1024 px descubrió que las etiquetas flotantes del hero estaban ancladas dentro de una envoltura absoluta de ancho cero y quedaban cortadas. Se posicionaron las etiquetas directamente sobre la capa del globo y se limitó su ancho a 15 rem. A 1024 px, las cuatro cajas quedaron dentro del viewport; se repitió la revisión en desktop grande y a `1024 × 768`.

## MAP POPULATED QA

Con tres ubicaciones se vieron San Francisco, Berlín y Tokio; el panel expuso cuatro historias con coordenadas y señaló por separado la única historia sin ellas. Las dos historias de Berlín se agruparon en una sola ubicación y su contexto mostró el número de historias correcto. Se comprobaron el mapa y los filtros a 375, 768, 1024 y 1440 px. El panel de historias ofrece enlaces textuales y el mapa tiene una descripción accesible.

## MARKER CLICK

Recorrido verificado a 375 px: se pulsó el nodo de Europa, apareció el contexto de Berlín con dos publicaciones, la tarjeta completa quedó dentro del canvas al desplazar la página y su enlace abrió `/qa-visual/article/qa-berlin-open-weights`. El destino mostró el artículo esperado. También se probó la activación por teclado (`Enter`) de un enlace del panel de historias.

## ARTICLE POPULATED QA

El artículo largo mostró H1, resumen, fecha, tiempo de lectura, imagen con alt, bloque `POR QUÉ IMPORTA`, cuerpo con varias secciones, tres fuentes y dos relacionadas. Los enlaces de origen usan `.invalid`; no se abrieron. La imagen SVG local cargó con ancho natural de 104 px y se presentó recortada como portada.

La variante breve sin imagen no dibujó una imagen rota. La ficha sin categoría, región ni coordenadas omitió esos metadatos y no alteró la jerarquía del cuerpo.

## RESPONSIVE

Todas las mediciones cumplen `documentElement.scrollWidth <= innerWidth`. Los anchos menores por 15 px corresponden al área de scrollbar del navegador. Las filas de filtros y los callouts móviles conservan su desplazamiento horizontal propio.

| Viewport | Ancho de documento observado | Revisión |
| --- | ---: | --- |
| `375 × 812` | 360 | Home, mapa, popup y artículo; PASS |
| `390 × 844` | 375 | Home y artículo; PASS |
| `768 × 900` | 753 | Home y artículo; PASS |
| `768 × 1024` | 753 | Home, mapa y artículo; PASS |
| `1024 × 768` | 1009 | Home, mapa y artículo; PASS |
| `1024 × 900` | 1009 | Home y artículo; PASS |
| `1280 × 800` | 1265 | Home y artículo; PASS |
| `1366 × 768` | 1351 | Home y artículo; PASS |
| `1440 × 900` | 1425 | Home, mapa y artículo; PASS |
| `1920 × 1080` | 1905 | Home y artículo; PASS |

## THEMES

Dark y light pasaron con contenido poblado. Se revisaron las superficies del mapa, las etiquetas del globo, tarjetas, fuente y contexto. El tema oscuro original quedó restaurado después de las pruebas.

## ACCESSIBILITY

- Jerarquía de títulos observada con un H1 y encabezados de sección en artículos.
- El mapa expone una descripción y un texto cercano sobre historias situadas y ausentes.
- Las historias se presentan como enlaces nativos; el enlace de Berlín abrió el destino con `Enter`.
- El SVG del fixture expone alt descriptivo; la variante sin imagen no crea un `<img>`.
- El foco `Tab` del enlace “Saltar al contenido” mostró un anillo visible; los enlaces de historia usan `focus-visible`.
- MapLibre conserva sus límites propios de teclado; el panel adyacente ofrece acceso textual a las historias.

## REAL EMPTY-STATE REGRESSION

El servidor de producción respondió `200` para `/` con cero filas. Se verificaron los estados honestos de portada, mapa y últimas noticias; no apareció el titular ni el contenido del fixture. El slug de prueba `/noticias/qa-aurora-global-model` respondió `404`, añadió `noindex` y no mostró el titular del fixture. El recuento público observado sigue en **0**.

## LIMITATIONS

- No se simularon fuentes reales ni artículos públicos con imagen: la vista publicada no expone campos de imagen.
- La prueba directa de error de Supabase en runtime no se ejecutó porque la revisión automática bloqueó el lanzamiento con variables sustituidas; la distinción entre error y vacío sí se prueba a nivel de resultado y de presentación.
- Se hicieron cero llamadas a proveedores de generación o ingesta. La revisión del mapa cargó tiles de la fuente cartográfica pública ya configurada; no se abrieron fuentes de artículos.
- No se hicieron escrituras en Supabase, cambios de esquema, migraciones ni despliegues.

## DEPLOY READINESS

**YES para pasar a 11C — preparación de deploy en Netlify.** El build de Netlify no depende de la disponibilidad de Supabase, las rutas temporales no están en la salida de producción y la regresión del estado vacío pasó. Este resultado no autoriza ni realiza un deploy. **Detenerse aquí; no desplegar automáticamente.**
