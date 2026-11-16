# UI-04 — Síntesis final E

**UI-04 READY: YES** · **Base: A — Atlas Editorial** · **Fecha de verificación: 2026-10-13**

## Decisión y alcance

E conserva A como estructura y base de producto, y toma exactamente dos ideas visuales de C:

1. El tratamiento orbital sutil alrededor del globo existente.
2. La jerarquía asimétrica de historias destacadas en desktop.

No se incorporaron el atlas de texto, etiquetas en inglés, tarjetas o tipografía de artículo de C, cambios de mapa, adaptadores del laboratorio ni contenido sintético. La promesa editorial en español, el globo y su componente, las tarjetas existentes, el fallback sin imagen y el carrusel móvil permanecen.

## Implementación

### Hero y globo

- Se añadieron dos elipses orbitales estáticas y discretas con CSS sobre el arte existente; no se incorporó una nueva animación, dependencia, asset ni dato geográfico ficticio.
- Los anillos heredan el contenedor decorativo existente. La composición y el orden responsive del Hero no cambian; los anillos no recortan el globo en móvil.
- Se conservaron la promesa, titular, resumen, CTA, métricas, recuperación de error y callouts móviles de A.

### Historias destacadas

- En desktop desde 1024 px, la primera historia ocupa 7 de 12 columnas y la segunda 5; las siguientes usan un ritmo de 4 columnas.
- Con tres historias, la composición se adapta según la imagen de portada del lead. Las filas finales se expanden cuando dividirlas en tercios dejaría un hueco aislado.
- Con una historia, ocupa todo el ancho; con cero, no se muestran tarjetas. El límite de selección sube de 5 a 12, sin duplicados ni placeholders.
- Se conserva el componente de tarjeta, el orden por fecha, los filtros existentes, el fallback editorial sin imagen y el carrusel A en móvil/tablet por debajo de 1024 px.
- El helper puro `getFeaturedStoriesGridConfig` mantiene los atributos de layout acotados y probables sin acoplarlos al contenido de laboratorio.

## Verificación

### Responsive y temas

Matriz inspeccionada en dark y light: `320×844`, `375×812`, `390×844`, `430×932`, `768×1024`, `1024×768`, `1280×800`, `1366×768`, `1440×900` y `1920×1080`.

- Sin overflow horizontal del documento, recorte del globo ni desbordamiento del titular del Hero o de las tarjetas.
- Se revisaron Hero, destacadas, mapa, últimas noticias y footer; en desktop y móvil el mapa conserva un único canvas.
- En producción se comprobaron las cuatro combinaciones de inicio `1440×900` y `390×844` en dark/light. En 390 px la página mantiene su ancho y el globo cabe en el viewport.
- Los estados de historias `0/1/2/3/5/12` se revisaron en desktop a 1440 px y móvil a 320/390 px, combinando lead con/sin imagen y titulares cortos/largos. Móvil sigue en carrusel horizontal.

### Navegación, mapa y artículo

- Smoke de producción: `Calor` y `Nodos` responden y actualizan `aria-pressed` correctamente.
- Smoke de producción: la ruta de artículo muestra el H1 y los enlaces de fuentes.
- No se editaron los archivos de artículo, mapa, últimas noticias, header, footer ni legal en esta fase.
- Se mantienen fuera de alcance: `MAP-F01` — restaurar estado/filtros del mapa al volver de un artículo; `MAP-F02` — leyenda de intensidad de Calor; filtros del mapa compartibles por URL como mejora futura.

### Accesibilidad y rendimiento

- El ornamento orbital es decorativo y hereda el aislamiento accesible del escenario existente; no transmite información solo visual.
- Se conservan los controles y etiquetas existentes. CTA/controles comprobados mantienen objetivos táctiles de al menos 44 px donde se ajustó el área afectada; el foco visible de enlaces y controles no se reemplazó.
- Sin dependencias ni assets remotos nuevos. El tratamiento orbital es CSS estático y el helper de layout es una función pequeña sin runtime adicional.

### Consola y pruebas

| Comprobación | Resultado |
| --- | --- |
| `node --experimental-strip-types scripts/featured-stories-layout-unit-test.mjs` | PASS — `0/1/2/3/5/12`, lead con/sin imagen |
| `npm run frontend:public-content:unit` | PASS |
| `npm run lint` | PASS |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |
| `node scripts/safe-secret-audit.mjs` | PASS — 768 archivos, 0 hallazgos |
| Consola del navegador de producción | 0 errores y 0 warnings en inicio y smoke de mapa/artículo |

El build mostró el aviso preexistente de `NEXT_PUBLIC_SITE_URL` ausente o inválida, que deshabilita metadata de indexación local. SEO está fuera del alcance y no se cambió.

## Evidencia visual

Las vistas E se capturaron en el navegador durante QA para `1440×900` dark/light y `390×844` dark/light; también se capturaron estados con 1, 2 y 5 historias. El entorno CUA mostró esas capturas inline, pero no ofreció una ruta para guardar los PNG desde esa captura, por lo que no se inventan rutas de archivos E. Las capturas A de referencia están en:

- `C:\Users\Diego\.codex\visualizations\2026\10\12\01a131b3-d7d4-7612-81ac-6c516cd762d2\horizai-design-lab\screenshots\final\a-original\dark\1440\home-viewport.png`
- `C:\Users\Diego\.codex\visualizations\2026\10\12\01a131b3-d7d4-7612-81ac-6c516cd762d2\horizai-design-lab\screenshots\final\a-original\light\1440\home-viewport.png`
- `C:\Users\Diego\.codex\visualizations\2026\10\12\01a131b3-d7d4-7612-81ac-6c516cd762d2\horizai-design-lab\screenshots\final\a-original\dark\390\home-viewport.png`
- `C:\Users\Diego\.codex\visualizations\2026\10\12\01a131b3-d7d4-7612-81ac-6c516cd762d2\horizai-design-lab\screenshots\final\a-original\light\390\home-viewport.png`

Las referencias A son capturas del laboratorio con cinco historias sintéticas; la home de E se verificó con las dos historias públicas disponibles. Coinciden viewport y tema, pero no el conjunto de historias. El resultado visual se revisó sin cherry-picking; esta diferencia de fixtures y la falta de PNG E archivados quedan declaradas como límite de la evidencia persistente.

## Archivos de UI-04

- `app/globals.css` — transformaciones orbitales y reglas de jerarquía desktop/adaptación de filas.
- `components/news/featured/featured-stories-section.tsx` — límite de hasta 12 historias y datos de configuración del grid.
- `components/news/featured/featured-stories-layout.ts` — helper puro de configuración de estados.
- `scripts/featured-stories-layout-unit-test.mjs` — cobertura de los seis conteos y el estado con/sin imagen.
- `docs/ui-final-synthesis-e.md` — este informe.
- `artifacts/ui-final-synthesis-e.json` — registro estructurado de alcance y QA.

Los archivos fuente de UI ya tenían cambios locales antes de UI-04. El diff global de esos archivos incluye trabajo preexistente de A; este informe identifica únicamente las adiciones acotadas de esta fase y no atribuye ese trabajo previo a UI-04. No se revirtieron cambios del usuario.

## Límites externos

```text
providerCalls: 0
remoteWrites: 0
deploys: 0
```

No se implementaron los defectos MAP-F01/MAP-F02 ni los filtros compartibles por URL. No se hizo commit ni despliegue.
