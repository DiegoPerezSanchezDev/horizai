# HorizAI — revisión local de preparación para lanzamiento

Fecha de verificación: 10 de octubre de 2026\
Resultado: **LOCAL LAUNCH READINESS = NO**. La aplicación y su build local funcionan, pero falta confirmar el host público y resolver acciones humanas de contenido y seguridad. No se desplegó.

## Alcance y criterio

Se inspeccionaron las rutas públicas, el contrato de contenido y la configuración local antes de cambiar código. La intervención se limitó a metadatos SEO, URL canónica, JSON-LD seguro, sitemap, robots, iconos, tarjeta social, cabeceras HTTP y documentación de lanzamiento. Se conservaron los datos editoriales, las rutas de artículos y la arquitectura del mapa. El árbol ya tenía numerosas modificaciones de producto y del pipeline; no se intentó limpiarlas ni revertirlas.

No se ejecutó el pipeline ni ningún proveedor LLM. El smoke test cargó el contenido público existente desde la vista pública de Supabase; no se hicieron escrituras remotas. No hubo cambios de DNS, configuración remota, publicación, despliegue ni commit.

## Inventario y estado

La columna inicial refleja lo encontrado antes de esta fase; el estado actual distingue implementación local de preparación operativa.

| Superficie | Inicial | Estado actual / evidencia |
| --- | --- | --- |
| Rutas y metadata global | PARCIAL | Metadata API centralizada, títulos en español, plantilla, descripción y robots fail-closed. Canonical y social absoluto requieren `NEXT_PUBLIC_SITE_URL`. |
| Canonical y dominio | MISSING | Contrato implementado y probado; no existe host oficial confirmado en el repo. Build local sin URL emite `noindex, nofollow` y no crea canonical. **Confirmación humana pendiente.** |
| Metadata de artículos | PARCIAL | Usa titular, resumen disponible, fecha publicada y categoría real. Artículo publicado probado con Open Graph `article`. No se inventa imagen, autor o fecha modificada. Canonical e imagen social absoluta esperan el dominio. |
| JSON-LD | MISSING | Serializador escapa `<`, U+2028 y U+2029. WebSite/NewsArticle solo se emiten con una URL canónica configurada; no aparecieron en la build fail-closed actual. |
| Sitemap | MISSING | `/sitemap.xml` sirve un XML válido. Sin dominio queda vacío a propósito; con configuración consulta solo `public_published_articles`, pagina resultados y usa `updated_at` real. Excluye contenido archivado/no publicado y páginas legales provisionales. |
| Robots | MISSING | `/robots.txt` funciona. En build local sin dominio bloquea `/` y no anuncia un host inventado. Con host válido permite contenido público, excluye rutas internas conocidas y declara sitemap absoluto. No sustituye autorización. |
| Open Graph / Twitter | PARCIAL | Metadata de portada y artículo con fallback local `/social-card`; tarjeta PNG comprobada a 1200×630. Se sirve solo cuando existe host público. El artículo real no tiene imagen; se mantiene sin imagen editorial fabricada. |
| Favicon / Apple icon | INCORRECTO | El `favicon.ico` existente no coincidía con la marca. Se retiró y se usa `icon.svg` con el globo azul/blanco ya presente en la cabecera, más `apple-icon` PNG generado de 180×180. Ambos responden 200. |
| Manifest / theme | PARCIAL | Manifest mínimo con `display: browser`, identidad real y dos iconos. Theme color declara colores para tema claro y oscuro. No se anuncia instalación PWA. |
| Privacidad / términos | PLACEHOLDER | Ambos textos se identifican como provisionales y piden revisión antes del lanzamiento. No se alteraron ni se reclama cumplimiento legal. Revisión humana/legal pendiente. |
| Contacto | PLACEHOLDER | `hola@horizai.es` está descrito en el contenido como placeholder no confirmado. No se cambió ni se envió correo. Canal operativo pendiente. |
| Metodología / sobre nosotros | PARCIAL | Texto editorial existente; falta confirmación humana de que las descripciones de procesos y posicionamiento correspondan al producto real. |
| Fuentes | EXISTS | Página informativa indica que los nombres son ejemplos y que la selección depende de cada historia. Sin cambio. |
| Cabeceras | MISSING | Se añadieron `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`; se quitó `X-Powered-By`. Comprobadas en build local. |
| CSP / HSTS | MISSING | No se desplegó una CSP sin prueba. HSTS queda para cuando se verifiquen dominio y HTTPS. **CSP compatible con Next/MapLibre pendiente antes del deploy.** |
| Variables de entorno | PARCIAL | `.env.local` está ignorado; auditoría segura sin hallazgos en 714 archivos antes de crear esta documentación. Valores secretos no se imprimen. Contrato y separación se describen abajo. |
| Netlify | EXISTS | `npm run build`, salida `.next`, Node 22 y plugin oficial `@netlify/plugin-nextjs`. Se quitó una declaración de funciones para un directorio que no existe. Sin login, vinculación o deploy. |
| Dominio y DNS | MISSING | No se encontró un dominio confirmado. Estrategia apex/`www`, host principal, redirect y DNS quedan como decisión humana. |
| Redirects / slugs | PARCIAL | No se añadieron redirecciones de host. Next mantiene su política por defecto sin slash final; slugs de los artículos no cambiaron. Host, HTTPS y `www` requieren plan después de elegir dominio. |
| 404 / errores / vacíos | PARCIAL | Rutas inexistentes y slug desconocido dan HTTP 404, con copy en español y robots noindex. Fallo de lectura de artículo usa el error boundary con error genérico. Estados vacíos y del mapa tienen mensajes existentes; no se alteraron datos para crear fixtures. La inyección de fallo de Supabase no se hizo en el build de humo. |
| Accesibilidad | PARCIAL | En navegador local se comprobó la estructura de landmarks, el enlace de salto, navegación de retorno, enlace a fuente y nombres de controles del mapa. El mapa carga y sus botones de zoom/centrado miden 44×44 px. Home y artículo no muestran overflow horizontal a 390×844. No se ejecutó una auditoría axe completa. |
| Reduced motion | PARCIAL | Hay una regla CSS `prefers-reduced-motion`, pero la herramienta disponible no permite emular esa media feature. No se declara verificada la detención/reducción de cada animación. |
| Rendimiento | PARCIAL | Build de producción inspeccionado. Los chunks de `.next/static/chunks` suman 1.878.935 bytes sin comprimir; el mayor archivo es 1.012.179 bytes. Son tamaños de artefacto, no bytes transferidos de una carga real. No hubo LCP/CLS/INP ni Lighthouse verificables en esta herramienta. No se encontró un bloqueo P0 durante el smoke. |
| Imágenes | PARCIAL | `public-content-model` deja `imageUrl` en `null` para las historias públicas actuales. No se añadió wildcard a `remotePatterns`; `next/image` no se da por optimizado para futuros hosts desconocidos. La tarjeta social es local y medida. Estrategia de imagen editorial pendiente de hosts confirmados. |
| Mapa | EXISTS | Lazy load preservado. El mapa real cargó en producción local, controles accesibles presentes y `/maplibre/maplibre-gl-worker.mjs` respondió 200 (19.011 bytes). No se cambió MapLibre ni su estilo. |
| Consola / red | PARCIAL | En home, mapa y artículo del build local no se capturaron warnings ni errores de consola. El mapa y su worker cargaron. La interfaz del navegador no expuso waterfall/status completo de solicitudes, así que no se certifican todas las requests de terceros. |
| Observabilidad | PARCIAL | Logging existente de lecturas públicas registra ámbito y código saneado, no credenciales. Falta operar alertas/señales de plataforma y procedimiento de revisión para publicación/revisión humana. |
| Humo local | EXISTS | Checklist repetible en `docs/deployment-checklist.md`. Se ejercitaron las rutas HTTP principales con build de producción; detalles en la matriz de pruebas. |

`NOT REQUIRED`: autenticación de usuario y PWA instalable no forman parte del MVP descrito. `robots.txt` no es un control de acceso.

## URLs e indexación

`NEXT_PUBLIC_SITE_URL` es la única fuente del origen canónico. Se acepta una URL raíz HTTP/HTTPS sin ruta, credenciales, query ni fragmento; se normaliza con `URL`. En `production` solo se acepta HTTPS y se rechaza loopback. El test de contrato cubre normalización y rechazo. En ausencia de una URL válida, el sitio sigue arrancando, pero queda en noindex y sin metadata canónica para evitar indexar el host local o uno inventado.

La variable se define **en el build de Netlify** y se vuelve a compilar al cambiar el dominio. No se añade `NEXT_PUBLIC_APP_URL` antiguo ni una URL local. Con dominio confirmado, el sitemap incluirá `/`, `/sobre-nosotros`, `/metodologia`, `/fuentes` y los slugs que devuelve la vista de publicaciones públicas, con `lastModified` solo desde `updated_at` real. Las páginas de privacidad, términos y contacto no se indexan mientras su contenido siga provisional.

La política definitiva debe elegir apex o `www`, dejar el otro host con un único 301, forzar HTTPS y mantener la forma de slug publicada. No se creó ningún redirect porque hoy no se conoce el dominio. No se alteraron slugs existentes.

## Datos de artículo y JSON-LD

Los artículos usan su titular, resumen si existe, fecha publicada y primera categoría disponible. Las imágenes editoriales solo se anuncian si existe una imagen real en el modelo; ahora son nulas. Se omiten autor, publisher, `dateModified`, `reviewedBy`, word count e imagen inventados. La tarjeta de sitio es un gráfico de marca, no se presenta como fotografía del artículo.

El JSON-LD escapa caracteres que podrían cerrar un elemento `script`. Se genera WebSite y NewsArticle solo cuando el host canónico está configurado, añadiendo exclusivamente campos presentes y URL canónica. La build comprobada no tenía `NEXT_PUBLIC_SITE_URL`, por lo que no sirvió JSON-LD, canonical, sitemap con artículos ni Open Graph absoluto; esto es el comportamiento deliberado de cierre seguro y confirma el bloqueo de dominio.

## Seguridad

Cabeceras actuales en `next.config.ts`:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-Frame-Options: DENY` (`frame-ancestors 'none'` será su equivalente en CSP)
- `X-Powered-By` desactivado

### CSP pendiente

No se instaló CSP porque aún no se ha observado una ejecución con política de reporte: una política mal ajustada puede impedir hidratación de Next, renderizado de MapLibre, workers o mosaicos. Antes de producción, configurar primero `Content-Security-Policy-Report-Only` en un preview HTTPS y revisar violaciones con la página de inicio, artículo, mapa nodos/calor, light/dark y los recursos de Supabase. Punto de partida a comprobar (no política aprobada):

```text
default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-{nonce-por-respuesta}'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org https://fonts.openmaptiles.org; font-src 'self' data: https://fonts.openmaptiles.org; connect-src 'self' https://tiles.openfreemap.org https://fonts.openmaptiles.org https://<host-exacto-del-proyecto-supabase>; worker-src 'self' blob:
```

El nonce debe generarse y propagarse por respuesta siguiendo el patrón de CSP de Next instalado; no basta añadir el header. La excepción `style-src-attr` es limitada a estilos inline que MapLibre requiere y debe verificarse. `NEXT_PUBLIC_MAP_STYLE_URL` puede cambiar el host: añadir el origen exacto observado, nunca un wildcard. Confirmar si la configuración real de mapa requiere otro host para `connect-src` o `img-src`. No permitir dominios de imagen editoriales hasta aprobar una lista real. No usar `unsafe-inline` en `script-src`.

HSTS no se fuerza en el servidor local HTTP. Después de confirmar el host, probar HTTPS y redirección HTTP→HTTPS en preview y acordar en Netlify o en la app una política inicial `max-age=31536000`; no activar `includeSubDomains` ni `preload` sin confirmar el control de todos los subdominios.

## Entorno y secretos

Auditoría por nombres/código; nunca se imprimieron valores:

| Variable | Clasificación | Uso esperado |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | BUILD_REQUIRED | Origen HTTPS confirmado; canónicos, robots, sitemap, JSON-LD y social. Recompilar al cambiarlo. |
| `NEXT_PUBLIC_SUPABASE_URL` | BUILD_REQUIRED / RUNTIME_REQUIRED | Lecturas server-side del contenido publicado; solo vista `public_published_articles`. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | BUILD_REQUIRED / RUNTIME_REQUIRED | Junto con URL para lecturas públicas. Se permite `NEXT_PUBLIC_SUPABASE_ANON_KEY` como compatibilidad heredada. Revisar RLS/policies. No incluir una service-role aquí. |
| `NEXT_PUBLIC_MAP_STYLE_URL` | OPTIONAL | Estilo MapLibre; si se personaliza, revisar el origen en CSP. El estilo público actual no requiere API key. |
| `NODE_VERSION=22` | BUILD_REQUIRED | Ya declarado en `netlify.toml`. |
| `SUPABASE_SECRET_KEY` | SERVER_ONLY | Cliente privilegiado de pipeline/CLI bajo `lib/agents`; no es necesario en la app pública Netlify y no debe añadirse a ella. |
| `SUPABASE_DIRECT_DB_URL` | SERVER_ONLY / LOCAL_ONLY | Comandos controlados de migración; fuera del sitio público y de su build. |
| `AGENT_API_KEY`, `CEREBRAS_API_KEY`, `CLOUDFLARE_AI_API_TOKEN`, `SCHEDULER_TRIGGER_SECRET` | SERVER_ONLY | Operación supervisada/pipeline; no necesarios ni configurados por esta fase en Netlify. Nunca prefijar con `NEXT_PUBLIC_`. |
| `AGENT_*`, `GROQ_*`, `CEREBRAS_MODEL`, `CLOUDFLARE_*`, `SCHEDULER_*` | SERVER_ONLY / OPTIONAL | Modelos, límites y scheduler de pipeline; mantener fuera del despliegue frontend salvo una futura arquitectura backend aprobada. |

`.env.local` está ignorado por Git. La ejecución final de `node scripts/safe-secret-audit.mjs` comprobó 718 archivos: `SAFE_SECRET_AUDIT PASS`, 0 archivos con hallazgos y `env_local_ignored=true`. Los resultados no guardan valores.

## Netlify, imágenes y hosting

Configuración local: `npm run build`, publish `.next`, Node 22 y `@netlify/plugin-nextjs`. El adaptador de Next de Netlify es la integración prevista para App Router, SSR y Route Handlers; sitemap público es dinámico y consulta Supabase, mientras iconos/manifest/robots se entregan como rutas metadata. El worker de MapLibre se copia durante `prebuild` a `public/maplibre`. No existe directorio de funciones Netlify dedicado ni se necesita uno para estas rutas. La documentación oficial de [Next.js en Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/) y de [configuración de builds](https://docs.netlify.com/build/configure-builds/file-based-configuration/) respalda el patrón; todavía requiere validar un deploy preview antes de dar compatibilidad de hosting por final.

No se configuraron `remotePatterns` abiertos. Cuando existan imágenes editoriales reales, confirmar dimensiones y orígenes usados por las publicaciones; añadir solo hosts concretos o almacenar assets bajo `/public`. No cambiar estrategia para compensar una puntuación sintética.

## Accesibilidad, rendimiento y observabilidad

El skip link y el foco se probaron manualmente en la revisión local previa; en el build de producción se revisaron navegación, headings, fuente original, controles del mapa y retorno desde artículo. Home y artículo no desbordan a 390×844. La interfaz disponible no ofrece axe ni emulación de `prefers-reduced-motion`; comprobar en un navegador DevTools/Playwright de preview antes de afirmar esos criterios. La existencia de reglas CSS no prueba el comportamiento.

El mapa permaneció lazy y después cargó con controles y atribución. Worker local HTTP 200. Los tamaños de chunk consignados arriba son archivos sin comprimir; no son LCP/transfer de usuario. Faltan métricas de LCP, CLS e INP/TBT con navegador de rendimiento real, desktop y móvil; no se detectó un bloqueo P0 visual/funcional en los recorridos verificados.

Señales de lanzamiento usando Netlify y logs existentes:

- respuestas 5xx y errores de función/SSR;
- lecturas públicas fallidas (el log actual entrega ámbito y código saneado; revisar volumen, no keys);
- error de carga de mapa/estilo/worker;
- latencia y respuesta del endpoint público/sitemap;
- publicación fallida, contenido omitido y cola de revisión humana en el sistema supervisado, monitorizados aparte del host frontend;
- eventos del scheduler y pipeline separados de los logs de lectura pública.

Al primer día, comprobar estos indicadores en el preview y después del deploy, mirar logs de Netlify, abrir home/artículo, verificar sitemap/robots, y confirmar mapa y lectura Supabase. No se incorporó un servicio de pago.

## Pruebas y humo local

| Prueba | Resultado |
| --- | --- |
| `npm run lint` | PASS |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS; Next 16.3.4, sin warning de runtime Edge ni de `next/image`. El log de build avisa que `NEXT_PUBLIC_SITE_URL` no es válido y desactiva indexación como se espera. |
| `npm run frontend:public-content:unit` | PASS; contenido público y aislamiento QA. |
| `node --experimental-strip-types scripts/launch-readiness-unit-test.mjs` | PASS; contrato URL e inyección segura JSON-LD. |
| `npm run secret:audit:unit` | PASS; detección sintética y formato saneado. |
| `node scripts/safe-secret-audit.mjs` | PASS final; 718 archivos, 0 hallazgos y `.env.local` ignorado. |
| Build local: `/`, artículos, 404, páginas informativas, robots, sitemap, manifest, iconos, social card y worker | PASS HTTP/content-type; dos artículos visibles; artículo real devuelve `og:type=article` y fecha publicada. |
| Cabeceras y `X-Powered-By` | PASS en respuestas de producción local. CSP/HSTS no están implementados. |
| Consola navegador local después de cargar mapa y abrir artículo | 0 errors, 0 warnings observados. |
| Reduced motion / waterfall / Web Vitals / inyección real de error Supabase | NO VERIFICADO: capacidades de navegador disponibles no las exponen o no permiten emularlo sin cambiar el entorno de build. |
| `git diff --check` | PASS; Git mostró avisos informativos de normalización LF/CRLF en archivos ya modificados. |

Smoke repetible detallado: `docs/deployment-checklist.md`. El servidor `next start` local debe usar el build más reciente y variables locales no sensibles; no uses un host local como URL canónica de producción.

## Blockers y acciones humanas

**BLOCKER / MUST BEFORE DEPLOY**

- Confirmar el dominio canónico y si será apex o `www`; definir redirect único, HTTPS, DNS y `NEXT_PUBLIC_SITE_URL` en el entorno de build.
- Revisión legal humana de privacidad y términos; cerrar finalidad/cookies y canal para derechos sin declarar cumplimiento no revisado.
- Confirmar y reemplazar el correo placeholder con canal operativo.
- Completar CSP en report-only sobre preview HTTPS con host Supabase y hosts efectivos del mapa; probar y después aplicar política, además de acordar HSTS.
- En preview, correr verificación final de reduced motion y métricas de rendimiento con herramienta que soporte emulación y Web Vitals.
- Repetir secret audit y pruebas sobre el worktree final antes del despliegue futuro.

**CAN DO AFTER DEPLOY**

- Ajustar remates de observabilidad/alertas de acuerdo con las capacidades ya disponibles en Netlify y Supabase, siempre que no reemplacen los controles previos de seguridad, legal, contacto o dominio.
- Revisar estrategia de imágenes editoriales cuando haya URLs/imágenes reales y hosts aprobados.

**HUMAN DECISION REQUIRED**

- Dominio, apex/`www`, DNS actual y host primario.
- Aprobación legal y contenido de las páginas provisionales.
- Confirmación operacional del correo.
- Orígenes exactos permitidos por CSP y política final HSTS.

Contadores de esta fase: proveedores LLM `0`; escrituras remotas `0`; deploys `0`; cambios DNS `0`; commits `0`.
