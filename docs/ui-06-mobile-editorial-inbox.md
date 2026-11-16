# UI-06 — Bandeja editorial móvil y base de notificaciones

Nota histórica: AUTH-01 sustituye el acceso anónimo a fixtures por autenticación y autorización de operador, también en desarrollo. La configuración vigente se describe en `docs/auth-01-editorial-operator.md`; las evidencias UI-06 conservan el estado anterior.

Fecha: 21 de octubre de 2026. Resultado: **PASS en modo fixture de desarrollo**. Preparado para UI-07 con notificaciones en vivo: **NO**.

## Objetivo, observación y plan

Permitir al operador leer una propuesta, entender su relevancia y sus fuentes, y ensayar la confirmación de una decisión desde el móvil. Esta fase no autoriza decisiones ni publicación.

Se siguió **OBSERVE → PLAN → EXECUTE → CRITIQUE → VERIFY**, consultando `docs/product-principles.md` y las guías de la versión instalada de Next.js 16.3.4 para layouts, páginas, componentes cliente, metadata, headers, notFound, CSP, proxy y devIndicators.

Hallazgos y alcance:

- **CRITICAL:** no existe una sesión web probada de operador. Mantener aislados los datos privados y bloquear el espacio editorial en producción.
- **CRITICAL:** `notFound()` durante streaming RSC podía producir HTTP 200, aunque sin contenido editorial. Se añadió un bloqueo previo al renderizado con el matcher exclusivo `/editorial/:path*`; las pruebas finales exigen HTTP 404 en HTML y RSC.
- **IMPORTANT:** faltaban bandeja, lectura, avisos, fuentes y confirmaciones para el operador. Se añadieron únicamente estas superficies, reutilizando tokens, tipografía y estilos de lectura Design E.
- **IMPORTANT:** la CSP existente impedía hidratar el runtime de desarrollo de Webpack. La excepción `unsafe-eval`, exigida por la documentación instalada, se limita a las rutas editoriales en `NODE_ENV=development`. Producción conserva su CSP estricta.
- **IMPORTANT:** el indicador flotante de desarrollo de Next.js interceptaba pulsaciones sobre la barra móvil. `devIndicators: false` evita ese conflicto; los errores de ejecución/compilación siguen disponibles.
- **POLISH:** se eliminó una métrica redundante de origen que rompía la composición móvil y se limitó el resumen de bandeja a dos líneas.
- **IGNORE:** rediseños de Home, mapa, artículos públicos, navegación y footer; integración del pipeline, proveedores, decisiones reales y despliegues.

## authAudit

Clasificación: **NO_OPERATOR_AUTH**.

La inspección local no encontró login de operador, sesión en cookies, `getUser`/`getSession`, autorización web de administrador ni un proxy/middleware previo. No se hizo ninguna consulta remota para este análisis.

Evidencias:

- `lib/supabase/server-client.ts`: cliente privilegiado para CLI/backend, con `persistSession: false`; utiliza una credencial del servidor. Su existencia no autoriza una petición web.
- `lib/agents/publisher/human-review-read-repository.ts`: RPC de lectura M32 y esquemas de contratos, sin una sesión web de operador.
- `supabase/migrations/20261007215233_human_review_operator_read_rpc.sql`: comprueba `auth.role() = service_role`; revoca acceso de roles públicos/autenticados y concede ejecución al rol privilegiado.
- El listado M32 omite cuerpos y el detalle requiere el artefacto inmutable validado. No basta con conectar el listado a una pantalla.

No se modificó ninguno de esos archivos. No se importan agentes ni Supabase desde `lib/editorial`.

## routeProtection

Rutas:

- `/editorial`
- `/editorial?scenario=empty`
- `/editorial/reviews/[id]`

Solo se aceptan `NODE_ENV=development` y Host exacto `localhost`, `127.0.0.1` o `[::1]`, con puerto opcional. El servidor de QA se vinculó a `127.0.0.1:3016`.

Tres capas: proxy previo al streaming; guard en el layout; guard en el adaptador antes de importar fixtures. Ninguna variable permite activar un modo live. El Host es aislamiento del preview, **no autenticación**: no debe usarse para servir datos privados ni exponerse el servidor dev a una red no confiable.

El build local de producción devuelve 404 sin fixtures para las cinco URLs probadas y para una petición RSC directa. Las respuestas bloqueadas incluyen `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` y `Cache-Control: private, no-store, max-age=0`.

En desarrollo, Next.js sustituye Cache-Control por `no-cache, must-revalidate`. Solo se sirven ejemplos sintéticos. Metadata genérica, sin titulares en Open Graph/Twitter; `noindex` en metadata y cabecera; exclusión en robots; sin entrada de sitemap ni acceso desde la navegación pública. La falta local de `NEXT_PUBLIC_SITE_URL` sigue deshabilitando la indexación general.

## architecture y dataAdapter

`lib/editorial/data.ts` es `server-only` y expone `EditorialDataAdapter`:

```ts
listWaitingReviews(scenario?: "pending" | "empty"): Promise<EditorialReviewSummary[]>
getReviewForOperator(id: string): Promise<EditorialReview | null>
```

La implementación solo importa fixtures después del control de acceso. La bandeja filtra `WAITING_FOR_HUMAN_REVIEW && !consumed`. La lectura de un identificador desconocido termina en el estado no disponible. No hay selector live, credenciales, API de mutación ni llamadas a M31–M39.

Las páginas de servidor componen el contenido. Solo el cambio de tema y las confirmaciones requieren componentes cliente. La barra recibe titular y la identidad esperada; no recibe el DTO completo ni artefactos internos. Los estados de error y revisión ausente tienen salidas explícitas.

## editorialDTO y seguridad del cliente

`lib/editorial/review.ts` contiene un esquema Zod estricto y los tipos. Incluye reviewId, attemptId, reviewStatus, consumed, articleId nullable, draftId, humanRevisionId nullable, approvalTarget, approvalTargetSha256, sourceLineageSha256, criticProofStatus, m34Status, sourceLineageStatus y warnings. Añade únicamente contenido, metadata y referencias necesarios para el operador.

Las revisiones ORIGINAL y HUMAN_REVISION se validan contra la presencia de humanRevisionId. Los hashes tienen formato SHA-256. **Los hashes y PASS de los fixtures son sintéticos**, no una prueba criptográfica ni una validación de contenido real. Ranker admite valor disponible o null; los ejemplos usan null y la UI no inventa puntuaciones.

`getExpectedApproval()` conserva revisión/intento/borrador/artículo/revisión humana junto con estado, consumed y hashes esperados. Es un contrato futuro: no existe método de envío. El servidor futuro deberá rechazar datos desactualizados y volver a comprobar proofs y lineage vinculados al objetivo exacto.

La proyección de bandeja omite cuerpo, intentos y hashes. El esquema rechaza campos adicionales y URLs de fuentes no HTTPS. No se usan HTML arbitrario ni `dangerouslySetInnerHTML`. No se serializan prompts, razonamiento, credenciales, checkpoint blobs, cuerpos de extracción ni historia interna de la base de datos.

## screens y ejecución

La bandeja presenta pendientes, bloqueo, titular, resumen breve, motivo editorial, categoría/territorio, fecha absoluta en Europe/Madrid, fuentes y CTA Revisar. Solo muestra contadores calculados sobre los ejemplos visibles.

El detalle prioriza titular, resumen, Por qué importa, señales explícitas, avisos, texto completo propuesto, fuentes y detalles técnicos plegados. Cada fuente tiene publisher, título, clasificación y fecha cuando existe; los enlaces son HTTPS, abren nueva pestaña y usan noopener/noreferrer. Todos los enlaces de fixtures conducen a example.org y se identifican como simulados.

Fixtures originales escritos para esta fase:

| ID | Estado |
| --- | --- |
| demo-madrid | WAITING normal, pruebas simuladas PASS |
| demo-warning | WAITING con BLOCKER, WARNING e INFO; M34/lineage sin superar |
| demo-corrected | WAITING con objetivo HUMAN_REVISION, demo-revision-02 y hash diferente |
| scenario=empty | Bandeja sin pendientes |

Publicar, mantener y rechazar abren un diálogo nativo modal. Publicar muestra “Se publicará esta revisión exacta”, identidad y hash. Mantener explica que la propuesta quedaría pendiente. Rechazar incluye reconocimiento deliberado. **La confirmación final siempre está deshabilitada**, incluso tras marcar el reconocimiento. No hay éxito ficticio ni alteración del estado de revisión.

## notificationContract y notificationEligibility

`lib/editorial/notifications.ts` define notificationId, reviewId, headline, shortReason, createdAt, status, targetPath y dedupeKey. Texto de presentación: “Noticia lista para revisar”; no se incluyen cuerpo del artículo, prompts, pruebas ni extracciones.

El helper puro requiere revisión existente, WAITING_FOR_HUMAN_REVIEW, consumed=false, prueba durable Critic PASS, M34 PASS, lineage PASS y objetivo/hash válido. Retorna `eligible`, razones deterministas y dedupeKey. También consulta claves notificadas/reservadas suministradas por el llamador. El umbral editorial es opcional y explícito; no se aplica ninguno por defecto. `prepareEditorialNotification()` retorna null si no es elegible o la fecha no es válida. Preparar un objeto no realiza entrega.

## dedupeStrategy

Clave determinista: tupla JSON versionada con reviewId, tipo de objetivo, identidad de revisión humana o borrador, hash de objetivo y hash de lineage. Cambios de copy, fechas o nuevas observaciones no generan otra clave; otro objetivo/hash/lineage sí la cambia.

El estado suministrado distingue claves entregadas y reservadas. Las dos suprimen nuevos intentos. **No existe persistencia ni reserva atómica en UI-06**; UI-07 necesitará almacenamiento durable y coordinación para evitar carreras entre trabajadores. No se modificó el esquema de la base de datos.

## Base de cliente y service worker

Existe un manifest con `display: browser`. No se encontró service worker registrado por la aplicación ni una arquitectura push existente que reutilizar. El worker de MapLibre es un worker del mapa y no se toca.

`notification-client.ts` detecta contexto seguro, soporte, permiso y estado de suscripción; solo consulta un registro ya existente. No registra workers, solicita permisos ni crea suscripciones. La apertura de destino acepta exclusivamente `/editorial/reviews/<id>` local y rechaza destinos externos, traversal y query strings.

Preview de notificación nativa: **SKIPPED**. Sin worker ni infraestructura móvil existente, se conserva esta fase como una abstracción de lectura; no se solicitan permisos del sistema ni se eluden restricciones del navegador. Entrega push real: **NOT IMPLEMENTED**. No VAPID, Firebase, OneSignal ni proveedor de pago.

## CRITIQUE, responsiveQA y accessibility

Se inspeccionaron composiciones y medidas en navegador real: 320×740, 375×812, 390×844, 430×932, 768×1024, 1024×768, 1280×800, 1366×768, 1440×900 y 1920×1080. Bandeja y detalle sin overflow horizontal; variantes claras y oscuras en los cuatro tamaños solicitados; vacío, bloqueo y confirmaciones con capturas en `artifacts/ui-06/evidence`.

Se comprobaron barra fija al borde inferior, botones de aproximadamente 46.4 px, wrapping de titulares/hashes, desplazamiento del diálogo a 320 px, fuentes con áreas superiores a 44 px, detalles plegables y navegación de ida/vuelta. La barra reserva padding inferior y `env(safe-area-inset-bottom)`; el diálogo usa `dvh` y safe area. No se probaron un iPhone físico, VoiceOver ni entrega push en iOS.

Encabezados semánticos, estados con texto además de color, foco visible, labels, fuentes que anuncian nueva pestaña y diálogo etiquetado. Verificados foco inicial en volver, Tab/Shift+Tab dentro del diálogo, Escape, restauración al botón de origen y bloqueo del scroll de fondo. Rechazo con checkbox explícito y confirmación deshabilitada. Se reutilizan colores de contraste Design E y la regla global de reduced-motion; no se añaden animaciones.

La segunda revisión eliminó la métrica de origen redundante, corrigió plural de fuentes/título metadata duplicado y resolvió CSP/indicador de desarrollo. La sesión final estable registró **0 errores y 0 avisos de consola**, foco visible y navegación/confirmaciones correctas. Los scripts, estilos e imágenes presentes en el DOM son locales. La herramienta no expone una traza completa de red/performance: no se afirma haber inspeccionado todas las peticiones del runtime. Las pruebas HTTP locales y la inspección del código confirman el bloqueo y la ausencia de operaciones editoriales.

## tests y securityReview

Comandos y evidencias:

```powershell
node --conditions=react-server --experimental-strip-types --test scripts/editorial-ui-06-unit-test.mjs
node scripts/editorial-ui-06-route-test.mjs development
node scripts/editorial-ui-06-route-test.mjs production
npm run lint
npx tsc --noEmit
npm run build
git diff --check
node scripts/safe-secret-audit.mjs
```

Los 11 grupos unitarios cubren DTO/proyección, filtros waiting/consumed, gates Critic/M34/lineage, objetivos/hashes, stale representation, umbral optativo, dedupe entre observaciones, payload mínimo, SSR del cliente y aislamiento fixture/live. Las pruebas HTTP solo aceptan origen loopback y solo realizan GET. El Host hostil se envía con node:http porque fetch lo normaliza.

Las pruebas de producción analizan además los bundles estáticos de cliente para credenciales y cuerpos de fixtures. No se leyó `.env.local`, no se imprimieron valores de credenciales ni se añadió ninguna dependencia. El build emitió el aviso esperado por ausencia de NEXT_PUBLIC_SITE_URL. El uso de strip-types emite avisos experimentales de Node; no son fallos del producto.

Resultado final y rutas de evidencia: `artifacts/ui-06-mobile-editorial-inbox.json`, logs de lint/TypeScript/build/unit/secret audit y JSON de rutas/QA en `artifacts/ui-06/`.

## knownLimitations y nextPhase

- No hay autenticación/autorización web de operador: producción está cerrada, incluso para un supuesto usuario autenticado.
- El adaptador live necesita sesión probada, autorización en cada lectura y carga/validación de artefactos inmutables; no basta con usar una credencial privilegiada.
- Las pruebas PASS y hashes de fixtures no verifican contenido real. No se mostrará ningún indicador live sin prueba durable de su revisión exacta.
- No hay operaciones editoriales, revalidación remota de decisiones, entrega de notificaciones, SW, suscripción, reserva atómica ni almacenamiento de dedupe.
- Verificación responsive en navegador Windows; safe area e iOS requieren validación en dispositivo real antes de activar el flujo móvil en vivo.
- No está disponible una traza completa de red del navegador; se verificaron consola, recursos DOM, respuestas HTTP locales y ausencia de llamadas remotas en la nueva arquitectura.
- UI-07 debe definir privacidad del payload/lock screen, permisos móviles, transporte, identidad durable y reintentos sin duplicados; después podrá conectar el adaptador detrás de autorización.

Publicar/mantener/rechazar remotos: **0**. Cambios en pipeline, scheduler, proveedores, accounting, M31–M39 y migraciones: **0**. Escrituras editoriales remotas: **0**. Push real: **0**. Despliegue, DNS y Netlify producción: **NO**.

## Archivos de esta intervención

- Nuevos: `app/editorial/{layout,page,not-found,error}.tsx`, `app/editorial/editorial.css`, `app/editorial/reviews/[id]/page.tsx`.
- Nuevos: `components/editorial/review-actions.tsx`, `components/editorial/review-presentation.tsx`.
- Nuevos: `lib/editorial/{access-policy,access,data,fixtures,review,notifications,notification-client}.ts` y `proxy.ts`.
- Nuevos: los dos scripts `editorial-ui-06-*`, este documento y las evidencias UI-06.
- Ajustes mínimos compartidos: `next.config.ts` y exclusión editorial en `app/robots.ts`.

El repositorio ya contenía numerosos cambios y archivos sin seguimiento. No se revirtieron, incorporaron a commits ni ejecutaron scripts de esos trabajos.
