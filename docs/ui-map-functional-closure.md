# UI-05 — cierre funcional del mapa

**Estado:** READY = YES\
**Diseño E:** congelado; UI-05 no reabre decisiones visuales.\
**Fecha de verificación:** 13 de octubre de 2026.

## Resultado

MAP-F01 y MAP-F02 pasan en la build de producción. Los filtros se serializan en la URL, el mapa se recupera al volver desde un artículo y Heat presenta una escala cualitativa. No se modificaron el Hero, el globo orbital, la jerarquía de historias destacadas, el diseño del artículo, últimas noticias, cabecera, pie ni el sistema de tema.

## MAP-F01 — restauración de estado

Antes del cambio, el modo, los filtros y la ubicación seleccionada vivían en estado local de React. Los enlaces del mapa abrían artículos sin contexto y el enlace de retorno del artículo apuntaba siempre a `/#ultimas-noticias`.

El estado recuperable usa parámetros legibles de URL:

| Campo | Parámetro | Valores actuales | Predeterminado |
| --- | --- | --- | --- |
| Vista | `map` | `nodes`, `heat` | `nodes` |
| Periodo | `period` | `24h`, `7d`, `30d` | `30d` |
| Región | `region` | `GLOBAL` en los datos actuales | Todos |
| Tema | `topic` | `empresas`, `investigacion`, `modelos` | Todos |

Los valores predeterminados se omiten. Al cambiar filtros se llama a `history.replaceState(null, ...)`, que actualiza `useSearchParams` de Next sin crear una entrada por cada ajuste. Los enlaces a artículos desde el panel incluyen `fromMap=1` y el estado no predeterminado. El botón «Volver al mapa» restaura ese contexto con reemplazo de historial; Atrás del navegador vuelve a la entrada filtrada anterior. Abrir un artículo desde portada conserva «Volver a las noticias».

**Campos restaurados:** modo, periodo, región y tema/categoría.\
**Recarga:** PASS; la ruta filtrada vuelve a seleccionar los mismos controles.\
**Atrás del navegador:** PASS.\
**«Volver al mapa»:** PASS; no crea un bucle hacia el artículo.\
**URL compartible como efecto secundario:** sí.\
**Selección de ubicación y cámara:** no se serializan; son estado transitorio y no hacen falta para restaurar los filtros.

`fromMap` y los parámetros del mapa no se añaden a los canonical. La metadata del artículo se calcula con la ruta del artículo, sin parámetros de búsqueda. En este entorno local `NEXT_PUBLIC_SITE_URL` no está configurada, por lo que la aplicación no emite canonical ni metadata de indexación; la build muestra ese aviso ya existente.

## MAP-F02 — leyenda Heat

La leyenda se muestra solo en vista Calor, con estado de datos listo y al menos una ubicación mapeada. Presenta «Intensidad relativa» con los extremos «Menor» y «Mayor» y un gradiente decorativo. No atribuye conteos, porcentajes ni probabilidades a los colores. El grupo tiene nombre accesible; las etiquetas comunican la dirección sin depender solo del color.

La leyenda no aparece en Nodos, ante error de datos ni cuando los filtros dejan el mapa sin ubicaciones. Se revisó en tema oscuro y claro, a 1440 px; no tapa los controles de mapa. En 390 px conserva espacio y no produce desbordamiento horizontal.

## Datos observados y límites de la matriz

La portada contiene dos historias públicas del 29 de septiembre de 2026, ambas con región `GLOBAL`; los temas disponibles son Empresas, Investigación y Modelos. Por ello la matriz se ejecutó con valores reales `GLOBAL` e `investigacion`. Europa y Robotics no están en esta muestra; sus parámetros se comprobaron como valores desconocidos y caen de forma segura a los predeterminados.

Con fecha de verificación 13 de octubre, «Últimos 7 días» no contiene historias. En ese estado el mapa queda vacío y la leyenda se oculta correctamente. Para probar la navegación de ida y vuelta se usaron Calor + 30 días + Global + Investigación, que devuelve una historia ubicada.

## Responsive y regresión visual

La matriz de vista se comprobó en 320, 375, 390, 430, 768, 1024, 1280, 1440 y 1920 px. No hubo overflow horizontal; en los nueve anchos la leyenda quedó dentro del marco del mapa y fuera de los controles. La build de producción mostró el canvas MapLibre, el mapa y la ubicación pública; el panel conservó los enlaces a artículos.

Las capturas de portada verifican el globo orbital de E en oscuro y claro, en escritorio y móvil. El test de historias destacadas volvió a pasar con 0/1/2/3/5/12 historias y ambos estados de imagen principal. No se tocaron archivos de diseño de las otras secciones.

## Evidencia PNG

Las capturas se guardan en `artifacts/ui-map-functional-closure/evidence/`. Son vistas del repositorio real con contenido público actual, en PNG de viewport, no fixtures del Design Lab.

| Evidencia | Archivo |
| --- | --- |
| Portada, 1440, oscuro | `e-home-1440-dark.png` |
| Portada, 1440, claro | `e-home-1440-light.png` |
| Portada, 390, oscuro | `e-home-390-dark.png` |
| Portada, 390, claro | `e-home-390-light.png` |
| Artículo, 1440, oscuro | `e-article-1440-dark.png` |
| Artículo, 390, oscuro | `e-article-390-dark.png` |
| Mapa Nodos, 1440, oscuro | `e-map-nodes-1440-dark.png` |
| Mapa Calor y leyenda, 1440, oscuro | `e-map-heat-legend-1440-dark.png` |
| Mapa Calor y leyenda, 1440, claro | `e-map-heat-legend-1440-light.png` |
| Mapa Calor y leyenda, 390, oscuro | `e-map-heat-legend-390-dark.png` |
| Estado filtrado antes de abrir el artículo | `e-map-filtered-before-article-1440-dark.png` |
| Estado restaurado con Atrás del navegador | `e-map-restored-after-browser-back-1440-dark.png` |

El generador reproducible está en `scripts/capture-ui-map-functional-closure.mjs`; usa Chrome aislado contra `http://localhost:3000` y escribe el JSON de resultados junto a esta documentación.

## Producción, consola y acciones externas

En producción: canvas y mapa cargados; 0 errores de consola del navegador, 0 excepciones de runtime y 0 solicitudes fallidas en la captura automatizada. Hubo dos avisos de stream interrumpido en el log de Next mientras la prueba cambiaba de ruta; corresponden a navegaciones de prueba canceladas, sin errores de consola ni fallos de solicitud del navegador.

**Llamadas a proveedores de contenido o generación:** 0. La visualización existente leyó teselas públicas de OpenFreeMap/OpenMapTiles para presentar el mapa.\
**Escrituras remotas:** 0.\
**Deploys:** 0.\
**Commits:** 0.

## Verificación

| Comprobación | Resultado |
| --- | --- |
| `node --experimental-strip-types scripts/map-url-state-unit-test.mjs` | PASS |
| `npm run frontend:public-content:unit` | PASS |
| `node --experimental-strip-types scripts/featured-stories-layout-unit-test.mjs` | PASS |
| Smoke de producción: canvas, navegación, Atrás, retorno y recarga | PASS |
| Viewports móvil/escritorio y temas oscuro/claro | PASS |
| `npm run lint -- --quiet` | PASS |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS; aviso existente por `NEXT_PUBLIC_SITE_URL` ausente |
| `git diff --check` | PASS |
| `node scripts/safe-secret-audit.mjs` | PASS; 775 archivos revisados, 0 hallazgos; `.env.local` ignorado |
