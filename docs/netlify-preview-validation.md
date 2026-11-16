# Validación del preview QA de Netlify — LR-02

Fecha: 2026-10-11\
Resultado: **INCOMPLETA — draft limpio listo; el sitio permanece privado mientras se espera autorización para eliminar un draft anterior que expone archivos del repositorio.**

## Identidad y estado actual

- Sitio único: `horizai-lr02-qa-preview` (`53b30110-9020-4836-b043-d9306c3d7f96`).
- Draft limpio: `6acbb82ca8d2f5445d849138`, `https://6acbb82ca8d2f5445d849138--horizai-lr02-qa-preview.netlify.app`.
- Estado actual de visibilidad: **Private**. Las peticiones anónimas de ambos drafts vuelven a responder 401.
- No se creó ni publicó un deploy de producción, ni se cambió dominio/DNS.
- Al seleccionar Public, la UI desactivó el alcance “Previews only” y guardó **Production: Public / Deploy Preview: Public**. Para no dejar accesible el draft defectuoso, se volvió a Private. Netlify no permite mantener solo el preview público con el selector actual. No hay producción desplegada.
- Se pidió autorización para eliminar solo el draft antiguo; Netlify documenta que la eliminación es permanente y también elimina URL, logs y artefactos: [Manage deploys](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/). No se eliminó.

## Incidente de publicación y corrección

El primer draft `6acb93b12bf071fd5ac32977` subió la raíz del repositorio (806 archivos) por no fijar el directorio publicado. Sus archivos fuente y documentos quedaron accesibles con HTTP 200 durante la comprobación pública, incluidos `package-lock.json`, `docs/product-principles.md`, `artifacts/netlify-preview-validation.json` y `app/page.tsx`. `/.env.local` respondió 404; la auditoría local final no encontró secretos. No hay un registro de accesos externos disponible aquí.

Se contuvo el acceso volviendo el sitio a Private y se generó el draft limpio en el mismo sitio con `--no-build --dir .netlify/static --functions .netlify/functions`, sin `--prod`. Netlify confirma 61 archivos totales (6,2 MB), 11 assets nuevos y 2 funciones. El navegador de archivos del deploy contiene `_next`, `maplibre`, `news`, `textures` y `netlify.toml`; las rutas de código fuente dan 404. No se pulsó **Publish deploy**.

## Validaciones realizadas

| Área | Resultado |
| --- | --- |
| Acceso anónimo actual | 401 para el home y assets en ambos drafts mientras el sitio permanece Private. |
| HTML/CSS/JS del draft limpio | Cuando el sitio estuvo público temporalmente: HTML 200; CSS y JS 200. Las rutas de archivos de código en el draft limpio respondieron 404. |
| SEO del HTML | En sesión del equipo sobre el draft limpio: `noindex, nofollow`, sin canonical y sin JSON-LD. No se configuró `NEXT_PUBLIC_SITE_URL`. |
| `robots.txt` / `sitemap.xml` | El draft inicial respondió 200; falta revalidar anónimamente en el draft limpio. |
| HTTPS / cabeceras | En el draft inicial: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` y `X-Frame-Options: DENY`. CSP ausente en esa respuesta; falta repetición anónima en el draft limpio. |
| Home / artículos | El nuevo draft SSR muestra la portada y dos artículos en sesión del equipo. |
| 404 de artículo y ruta general | Se vieron los mensajes esperados: “Esta noticia no está disponible” y “No encontramos esta página”. El estado HTTP exacto sigue pendiente. |
| MapLibre + worker | Canvas, controles y atribución OpenFreeMap/OpenMapTiles/OpenStreetMap montados en sesión del equipo. El inventario del navegador vio `/maplibre/maplibre-gl-worker.mjs` y el worker compartido. Estado anónimo pendiente. |
| Responsive | Incompleto. Intenté 320, 375, 390, 430, 768, 1024 y 1440 px; la capacidad viewport no cambió el `innerWidth` efectivo (1280 px). |
| Reduced motion | No disponible: el navegador expone viewport y visibilidad, sin emulación `prefers-reduced-motion`. |
| Performance | Sin métricas fiables; la API Performance no está expuesta por el evaluador del navegador. |
| Console/network | En sesión del equipo: 1 error React minificado #418 (hydration mismatch), 0 warnings. La sesión inyecta Netlify HUD; falta reproducir sin HUD en acceso anónimo. |
| Logs runtime de Netlify | 10 eventos del handler de Next (8 info, 2 warn); ambos avisos mencionan `NEXT_PUBLIC_SITE_URL` ausente, intencional. No hubo llamada ni invocación al scheduler. |

## Configuración y auditoría

Variables públicas presentes solo en contexto Deploy Previews: `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. `NEXT_PUBLIC_SITE_URL` y `SCHEDULER_TRIGGER_SECRET` siguen sin configurar; no se usaron proveedores ni se mutó Supabase.

La auditoría final `node scripts/safe-secret-audit.mjs` pasó: 731 archivos, 0 con hallazgos y `.env.local` ignorado. La auditoría previa de bundles .next/.netlify también pasó con 787 archivos de texto y 0 valores privados locales. No se ejecutaron pipeline/scheduler ni se modificaron artículos, reviews o attempts.

Contadores: `providerCalls: 0`, `pipelineRuns: 0`, `schedulerRuns: 0`, `supabaseWrites: 0`, `dnsChanges: 0`, `customDomainChanges: 0`.

**NETLIFY QA PREVIEW READY: NO.** La implementación de publicación está corregida en el draft limpio, pero el sitio está Private hasta resolver la eliminación permanente del draft anterior. La validación anónima completa, responsive y de performance queda pendiente.
