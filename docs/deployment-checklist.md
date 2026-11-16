# Checklist de despliegue futuro — HorizAI

Este procedimiento describe trabajo futuro y permanece sin ejecutar. Requiere dominio, contenido legal/contacto y seguridad aprobados. La build local actual no está lista para servir tráfico público indexable: al faltar `NEXT_PUBLIC_SITE_URL` bloquea robots e indexación de forma deliberada.

## Antes de crear el deploy

1. Revisar el diff completo y separar cambios de launch-readiness de las modificaciones preexistentes del pipeline/producto. Confirmar que no hay trabajo sin revisar ni artifacts privados que deban mantenerse locales.
2. Confirmar el host canónico (`apex` o `www`), registrar el host alternativo para redirección única y comprobar control de DNS. No asumir proveedor ni registros existentes.
3. Obtener aprobación humana/legal de `/privacidad` y `/terminos`; confirmar política real de cookies/analítica y canal de derechos. Verificar que `hola@horizai.es` recibe mensajes o sustituirlo por el canal aprobado.
4. Repetir `node scripts/safe-secret-audit.mjs`; exigir 0 hallazgos y `.env.local` ignorado. Nunca cargar credenciales privilegiadas al navegador.
5. Con variables permitidas ya aprobadas, ejecutar localmente:

   ```bash
   npm run lint
   npx tsc --noEmit
   npm run frontend:public-content:unit
   node --experimental-strip-types scripts/launch-readiness-unit-test.mjs
   npm run build
   git diff --check
   ```

6. Configurar en el entorno de **build** de Netlify: `NEXT_PUBLIC_SITE_URL` (origen HTTPS aprobado), `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (o fallback legado ya usado por el código), más `NEXT_PUBLIC_MAP_STYLE_URL` solo si se ha elegido un estilo alternativo. `NODE_VERSION=22` ya está en `netlify.toml`.
7. No añadir `SUPABASE_SECRET_KEY`, `SUPABASE_DIRECT_DB_URL`, claves de agente/proveedores ni secretos del scheduler al frontend. Son para backend/CLI/pipeline por separado; ninguna operación de pipeline pertenece a este deploy.

## Preparar y revisar preview

8. Un responsable humano crea o selecciona el sitio Netlify, conecta el repo/branch y revisa comando `npm run build`, publicación `.next`, Node 22 y plugin `@netlify/plugin-nextjs`. Sin autenticación o cambios remotos hechos por esta fase.
9. Generar un deploy preview HTTPS. Primero mantener `Content-Security-Policy-Report-Only`; revisar reportes para Next, MapLibre, OpenFreeMap, glyphs/tiles, Supabase y cualquier origen de imagen real. Aprobar política y mecanismo de nonce antes de enforcement.
10. En preview, recorrer checklist de humo de abajo, desktop y móvil; emular `prefers-reduced-motion: reduce`; observar consola y waterfall; medir LCP/CLS/INP/TBT. No aceptar fallos de home, artículos, mapa, seguridad, fuga de secretos o estados legales.
11. Comprobar que todos los canonical usan el host elegido, robots permite las rutas públicas y declara sitemap con host correcto, y sitemap contiene solo rutas públicas y artículos publicados. Confirmar ausencia de privacidad/términos/contacto provisionales si permanecen `noindex`.
12. Comprobar redirect de una variante del host a la canónica (solo un 301), HTTP a HTTPS sin loops, normalización de slash según la política elegida y slugs publicados intactos.
13. Comprobar icono SVG, Apple PNG 180×180, manifest mínimo, tarjeta social PNG 1200×630 y preview OG en los validadores/plataformas previstos. Artículos sin imagen deben usar el fallback de marca del sitio, nunca imagen inventada.
14. Activar HSTS tras verificar HTTPS estable, con política acordada por el responsable de dominio; empezar sin `includeSubDomains`/`preload` hasta revisar todos los subdominios.

## Despliegue y observación

15. Confirmar la decisión humana para producción. Elegir deploy publicado de Netlify; este checklist no ejecuta ese paso.
16. Configurar DNS según instrucciones actuales del host y registrar el estado. Confirmar certificado HTTPS y redirect antes de indexar.
17. Verificar home, artículos, mapa/worker, cambio dark/light, controles nodos/calor, fuente original, contacto y legales en el dominio público.
18. Revisar canonical, `robots.txt`, `sitemap.xml`, manifest, OG/Twitter, cabeceras y ausencia de service-role/provider secrets en HTML, JS, logs y artefactos servidos.
19. Revisar logs SSR/funciones, errores de lectura Supabase, errores MapLibre y señales del sistema de publicación/revisión humana por separado. Vigilar respuestas 5xx, sitemap vacío inesperado y subida de errores del mapa.

## Humo repetible

- Home: HTTP 200; title/descripción en español; canonical del host confirmado; sin `noindex`; dos (o el conteo real vigente) historias públicas, sin datos inventados.
- Navegación: skip link, focus visible, landmarks, tema claro/oscuro, navegación por teclado; sin overflow desktop/móvil.
- Mapa: lazy load, worker `/maplibre/maplibre-gl-worker.mjs`, tiles, controles con nombres accesibles, Nodos y Calor, filtros y estado sin ubicaciones/error de recurso.
- Artículo publicado: HTTP 200, titular/resumen/fecha/category reales, JSON-LD con campos reales, enlace a fuente, retorno a home y fallback de imagen solo cuando aplique.
- Artículo inexistente/no publicado: HTTP 404, noindex, metadata tipo website/noticia no disponible, sin datos privados ni OG de artículo.
- Ruta desconocida: HTTP 404 y copy genérico en español.
- Contenido: páginas `/sobre-nosotros`, `/metodologia`, `/fuentes`, `/contacto`, `/privacidad`, `/terminos`; confirmar aprobación de copy y canal.
- Descubrimiento: sitemap XML parseable y limitado a páginas públicas y artículos publicados; robots con sitemap absoluto y rutas internas excluidas.
- Assets: manifest JSON parseable, `/icon.svg`, `/apple-icon` PNG 180×180 y `/social-card` PNG 1200×630.
- Seguridad: cabeceras, HSTS en HTTPS, CSP primero en report-only y después aplicada; confirmar cero violaciones necesarias para map, hidratación o Supabase.
- Errores: leer logs de navegador/Netlify; cero errores de app; identificar requests externas fallidas y clasificación, no ocultarlas.

No se ejecutaron estos pasos remotos ni el pipeline durante LR-01.
