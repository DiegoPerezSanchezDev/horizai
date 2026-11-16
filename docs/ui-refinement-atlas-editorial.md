# UI-02 — HorizAI Editorial Refinement

Fecha: 2026-10-09. Dirección: **Atlas Editorial**. Estado: implementación local y verificación completadas; **STOP — siguiente paso: revisión visual humana de Diego**.

## OBJECTIVE

Refinar hero móvil, header, historias y lectura editorial manteniendo identidad navy/azul, globo, fuentes, datos públicos, rutas y MapLibre. La fase toma como referencia [la auditoría UI-01](ui-audit-current.md) y sus evidencias en `artifacts/ui-audit/`. Esas evidencias y `docs/references/hero-approved.png` se conservaron.

El trabajo de esta fase se limita a frontend, documentación y evidencias locales. Provider calls: **0**. Remote writes: **0**. No hubo deploy, publicación ni commit. El árbol ya contenía numerosos cambios de otras fases; no forman parte de esta intervención.

## OBSERVE

Antes de editar se revisaron home, artículo y mapa renderizados en ambos temas, incluyendo la composición a 320, 375, 390, 430, 768, 1024 y 1440 px. También se leyeron componentes, reglas de producto y documentación instalada de Next.js 16.3.4 sobre layouts, CSS, componentes cliente/servidor y not-found.

| Problema | Causa observada |
| --- | --- |
| Corte rectangular del globo móvil | El globo es un SVG transparente, no un bitmap con fondo incrustado. El escenario tenía `overflow: hidden` y alturas de 188/220 px frente a una ilustración cuadrada de 244/288 px. El frame absoluto centraba el arte y recortaba halo/órbitas en los límites del escenario. No era un problema de `object-fit` ni una imagen fallida. |
| Movimiento tenue en claro | Órbitas y partículas conservaban colores luminosos/glow pensados para fondo oscuro, con poca separación sobre el hero claro. |
| Navegación desplazada | El contenedor flex sumaba marca, tagline, navegación y toggle; no reservaba columnas laterales simétricas. |
| Artículo con shell global | `NewsArticlePage` y su estado de error incorporaban `HeroHeader`, además de la navegación de regreso y padding superior. |
| Historias destacadas pequeñas | El grid desktop tenía cinco columnas aunque solo hubiera dos historias. El fallback de imagen ocupaba un 16:9 dominante; categoría/región carecían de separación editorial suficiente. |
| Últimas noticias débiles | Panel glass, lista dividida en dos columnas y espacio destinado a thumbs/índices aunque faltaran imágenes. Hover añadía fondo y señal lateral, dando una impresión de selección. La utilidad responsive `sm:block` también anulaba el clamp del resumen. |
| Repetición visual | Índices 01/02/03, mono, títulos parcialmente azules y cajas se repetían sin aportar orientación adicional. |
| Microtexto | Tokens faint demasiado claros; etiquetas y controles pequeños. El footer claro tenía algunos textos a 4,49:1, justo por debajo del umbral normal. |
| Mapa escaso | Dos publicaciones en una ubicación. La nota no explicaba suficientemente ventana temporal y alcance de la cobertura; el tratamiento oscuro seguía siendo una fortaleza. |

## PLAN

- **CRITICAL:** legibilidad, corte del globo, overflow a 320 px, foco y conservación del tema al retirar el header del artículo.
- **IMPORTANT:** centrado real del header, apertura del artículo, adaptación a pocos elementos, índice de noticias, continuación de lectura y contexto de cobertura.
- **POLISH:** callouts, contraste de movimiento en claro, repetición de pills/mono/glow y ritmo entre secciones.
- **IGNORE:** reemplazo de fuentes, rediseño de cartografía, búsqueda/suscripción, arquitectura de datos y refactors de pipeline.

## EXECUTE

### Hero y encabezado

El escenario móvil del globo tiene proporción cuadrada y overflow visible; la ilustración queda centrada dentro de su tamaño disponible. Se eliminaron las alturas pequeñas que competían con el CSS responsive. A 320 px también se retiró el `min-width: 320px` del body, que forzaba overflow al descontar la barra de scroll. No se cambió el asset ni se añadió blur para ocultar el corte.

En claro, las órbitas/partículas usan azul profundo `#1546d4`, grosores y opacidades propios; las rutas interiores conservan contraste sobre la esfera oscura. El tema oscuro mantiene su tratamiento. Los callouts tienen superficies y sombras contenidas y siguen siendo decorativos.

El header usa `minmax(0, 1fr) auto minmax(0, 1fr)` desde 768 px, con marca/navigation/toggle en inicio/centro/final. Mobile utiliza dos filas y controles cómodos. La promesa “La inteligencia artificial global, en español y con contexto.” permanece visible. Las métricas pasan a dos columnas abiertas; el CTA tiene 44 px en los tamaños móviles revisados. En desktop se conserva una primera pantalla dedicada al hero.

### Historias y últimas noticias

Las historias sin imagen se presentan como features de texto con regla superior. No se crea media ficticia. Las imágenes existentes siguen usando la rama de imagen real. La cuadrícula responde al número efectivo de historias: dos features de 596 px a 1440 px, frente a las cinco columnas anteriores; un elemento también ocupa el ancho disponible. Mobile conserva el carrusel accesible.

Categoría, región, titular, resumen y fecha/fuente tienen roles y espacios separados. Se retiraron los wrappers de filtros vacíos y la repetición de índices numerados.

“Lo más reciente” es una única lista ordenada con divisores, titular dominante, resumen acotado en desktop y metadata persistente. No tiene panel contenedor gigante, imagen de relleno, índice gráfico ni fondo de selección. Hover en puntero fino subraya el título. Filtros, enlaces, orden por fecha y expansión de 9 a más publicaciones siguen funcionando.

### Artículo y tema

Artículo, error y not-found local utilizan únicamente “Volver a las noticias”. La apertura mantiene lectura, fuentes y metadata, sin un spacer global vacío. El h1 aparece aproximadamente a **136 px en desktop y 120 px en mobile**, frente a unos 225/222 px antes.

“Por qué importa” es un bloque abierto con regla azul de 2 px y encabezado con divisor fino. Sin relacionados, “Sigue explorando” enlaza a rutas reales de últimas noticias/mapa.

Retirar el toggle del artículo expuso una dependencia de restauración de tema al montar el header. `ThemeInitializer` lleva esa responsabilidad al layout: mantiene el bootstrap previo al contenido SSR, restaura la preferencia al cambiar ruta y repara clases de tema ausentes tras recreación del documento. Se conserva `lib/theme`. La solución final evita insertar un script inerte durante navegación cliente. Home → artículo → regreso preserva claro y oscuro, sin warnings finales de hidratación.

### Mapa, etiquetas y footer

MapLibre, coordenadas, capas, lazy loading, worker y selección de historias no cambiaron. Se mejoraron etiquetas/controles, sombra y vignette en claro; se añadió el contexto real de período, publicaciones y ubicaciones, con una limitación explícita de cobertura. No se añadieron puntos.

Los tokens faint y la categoría sobre chip claro se oscurecieron. El footer conserva estructura y diseño; únicamente se reforzó el color del texto/enlaces en claro y su hover tras medir 4,49:1.

## CRITIQUE — antes frente a después

| Pregunta | Resultado de la segunda revisión |
| --- | --- |
| ¿La home sigue pareciendo un dashboard? | La promesa y la noticia lideran; features y lista abierta reducen el peso de chrome. El mapa conserva controles porque es una herramienta real. |
| ¿Dominan las cajas? | No en historias/artículo. Persisten las superficies del mapa, acciones, callouts y fuentes donde tienen una función clara. |
| ¿Últimas noticias sigue rota? | No: dos filas usan el ancho, los resúmenes están limitados y la altura depende del contenido. |
| ¿Destacadas sigue vacía? | No: dos columnas ocupan el ancho desktop y desaparece el 16:9 ficticio. Mobile invita al desplazamiento del rail. |
| ¿Sigue el corte rectangular? | No: escenario cuadrado y halo continuo. El documento completo a 320 px confirma la esfera completa; el borde del viewport inicial no es un recorte del contenedor. |
| ¿El movimiento en claro sigue invisible? | Las órbitas/partículas se distinguen; dos fotogramas y transforms/dash-offset distintos confirman animación real. |
| ¿El artículo sigue siendo un shell global? | No: solo regreso, contenido editorial y footer. |
| ¿La navegación está centrada? | Sí: desplazamiento máximo medido de 0,11 px respecto al centro útil del viewport desktop. |

Durante la crítica se corrigieron además el overflow de 320 px, CTA de 375 px, padding que Tailwind imponía a las secciones, clamp del resumen y conservación del tema. La revisión final de archivos detectó capturas con encuadres incorrectos: se sustituyeron comprobando tamaño CSS, clase de tema y scroll antes de guardar. No se modificaron las capturas históricas.

## VERIFY

### Responsive e interacción

Se registraron **60 observaciones DOM**: 10 tamaños × 2 temas × home/artículo/mapa. En todos: sin overflow horizontal; canvas dentro del viewport; artículo sin header global. Tamaños CSS:

| Viewport | Home | Artículo | Mapa |
| --- | --- | --- | --- |
| 320×812 | PASS | PASS | PASS |
| 375×812 | PASS | PASS | PASS |
| 390×844 | PASS | PASS | PASS |
| 430×932 | PASS | PASS | PASS |
| 768×1024 | PASS | PASS | PASS |
| 1024×768 | PASS | PASS | PASS |
| 1280×800 | PASS | PASS | PASS |
| 1366×768 | PASS | PASS | PASS |
| 1440×900 | PASS | PASS | PASS |
| 1920×1080 | PASS | PASS | PASS |

La diferencia máxima del centro del globo fue 0,01 px. En desktop, la sección siguiente comienza fuera del viewport inicial. El centro útil excluye la barra de desplazamiento del navegador.

- Teclado: foco visible en navegación, carrusel y última noticia; Tab revela la segunda feature. Sin `aria-selected` ni fondo permanente en filas.
- Mapa: Nodos/Calor, 24 h vacío, retorno a 30 días, zoom y reset revisados. Datos observados: 2 publicaciones, 1 ubicación; no se interpreta esto como cobertura mundial completa.
- Estados con 1/2/5/12 historias en 1440/390 y ambos temas: PASS. Con 12, se muestran 9 recientes y “Ver 3 más” expande a 12; destacados mantiene el límite existente de 5. Filtros de región/categoría: PASS.
- Imagen presente, ausencia de imagen, apertura larga a 320 px, relacionados, vacío/error y not-found: revisados. Para los estados que los datos reales no ofrecen se utilizaron fixtures existentes en rutas QA locales temporales. Esas rutas se eliminaron antes del build final; no se duplicaron datos de producción ni se alteraron los fixtures existentes.
- Contraste calculado sobre colores CSS compuestos: 47 muestras de home por tema, mínimo 4,81:1 claro / 5,14:1 oscuro; 26 muestras adicionales de artículo y footer por tema, mínimo 4,81:1 claro / 5,48:1 oscuro. Footer claro corregido: texto sobre fondo base a 7,00:1.
- El cálculo trata RGB/sRGB y transparencias; no certifica cada píxel de gradientes/texturas. Las superficies radiales del hero se revisaron visualmente y se reforzó su texto con tokens de mayor contraste.
- Movimiento en claro: transform de órbita y dash-offset cambiaron entre fotogramas (`-15,44` → `-51,48` px). La animación sigue visible sin aumentar brillo global.
- Reduced motion: reglas CSS y rama `matchMedia` del carrusel inspeccionadas. La sesión tenía `prefers-reduced-motion: false`; **no se emuló la preferencia del sistema en el navegador**. No se presenta esa comprobación como una prueba visual con la preferencia activada.
- Consola final: 0 errores y 0 warnings capturados en la sesión final; sin errores de imagen ni de MapLibre observados.

### Verificación técnica

| Comando | Resultado | Evidencia |
| --- | --- | --- |
| `npm run lint` | PASS | [lint.log](../artifacts/ui-refinement/lint.log) |
| `npx tsc --noEmit` | PASS | [typescript.log](../artifacts/ui-refinement/typescript.log), vacío con exit 0 |
| `npm run frontend:public-content:unit` | PASS | [frontend-tests.log](../artifacts/ui-refinement/frontend-tests.log) |
| `npm run build` | PASS | [build.log](../artifacts/ui-refinement/build.log) |
| `git diff --check` | PASS | [diff-check.log](../artifacts/ui-refinement/diff-check.log) |

El test existente emite avisos de Node sobre type stripping/module type; termina con exit 0. Git puede emitir avisos de conversión LF/CRLF en este checkout; no son errores de whitespace. El build final incluye únicamente las rutas públicas existentes y not-found; no incorpora rutas QA. No se añadieron dependencias ni tests nuevos.

### Capturas reales antes/después

Home compara la apertura al mismo viewport; los `before-home-*` conservan además la página completa inicial. Las dimensiones de la tabla son el viewport CSS solicitado y comprobado; el exportador JPEG puede descontar la barra de scroll y normalizar ligeramente su tamaño. El JSON registra las dimensiones del archivo por separado. Capturas sin retoque.

| Superficie | Antes | Después |
| --- | --- | --- |
| Home 1440 dark | [Antes](../artifacts/ui-refinement/before-hero-1440-dark.jpg) | [Después](../artifacts/ui-refinement/after-home-1440-dark.jpg) |
| Home 1440 light | [Antes](../artifacts/ui-refinement/before-hero-1440-light.jpg) | [Después](../artifacts/ui-refinement/after-home-1440-light.jpg) |
| Home 390 dark | [Antes](../artifacts/ui-refinement/before-hero-390-dark.jpg) | [Después](../artifacts/ui-refinement/after-home-390-dark.jpg) |
| Home 390 light | [Antes](../artifacts/ui-refinement/before-hero-390-light.jpg) | [Después](../artifacts/ui-refinement/after-home-390-light.jpg) |
| Home 320 light | [Antes](../artifacts/ui-refinement/before-hero-320-light.jpg) | [Después](../artifacts/ui-refinement/after-home-320-light.jpg), [página completa](../artifacts/ui-refinement/after-home-320-light-full.jpg) |
| Article 1440 dark | [Antes](../artifacts/ui-refinement/before-article-1440-dark.jpg) | [Después](../artifacts/ui-refinement/after-article-1440-dark.jpg) |
| Article 1440 light | [Antes](../artifacts/ui-refinement/before-article-1440-light.jpg) | [Después](../artifacts/ui-refinement/after-article-1440-light.jpg) |
| Article 390 dark | [Antes](../artifacts/ui-refinement/before-article-390-dark.jpg) | [Después](../artifacts/ui-refinement/after-article-390-dark.jpg) |
| Article 390 light | [Antes](../artifacts/ui-refinement/before-article-390-light.jpg) | [Después](../artifacts/ui-refinement/after-article-390-light.jpg) |
| Map 1440 dark | [Antes](../artifacts/ui-refinement/before-map-1440-dark.jpg) | [Después](../artifacts/ui-refinement/after-map-1440-dark.jpg) |
| Map 1440 light | [Antes](../artifacts/ui-refinement/before-map-1440-light.jpg) | [Después](../artifacts/ui-refinement/after-map-1440-light.jpg) |
| Map 390 dark | [Antes](../artifacts/ui-refinement/before-map-390-dark.jpg) | [Después](../artifacts/ui-refinement/after-map-390-dark.jpg) |
| Map 390 light | [Antes](../artifacts/ui-refinement/before-map-390-light.jpg) | [Después](../artifacts/ui-refinement/after-map-390-light.jpg) |

Comparaciones adicionales: [destacadas antes](../artifacts/ui-refinement/before-stories-1440-dark.jpg) / [después](../artifacts/ui-refinement/after-stories-1440-dark.jpg); [últimas antes](../artifacts/ui-refinement/before-latest-1440-dark.jpg) / [después](../artifacts/ui-refinement/after-latest-1440-dark.jpg). Medidas: [measurements.json](../artifacts/ui-refinement/measurements.json). Resumen y manifest: [ui-refinement-atlas-editorial.json](../artifacts/ui-refinement-atlas-editorial.json).

## FINAL REPORT

| Campo solicitado | Resultado |
| --- | --- |
| Mobile globe cut | FIXED |
| Root cause | SVG transparente recortado por escenario bajo con overflow hidden; proporción y altura no contenían arte/halo. |
| Light globe motion | PASS |
| Desktop nav truly centered | YES |
| Theme toggle far right | YES |
| Article global header | REMOVED |
| Article opening | IMPROVED |
| Por qué importa treatment | Bloque abierto, regla azul fina, sin card/glow. |
| No-image fallback | Feature de texto editorial; sin media ficticia. |
| Featured stories low-count layout | PASS |
| Latest stories layout | PASS |
| Permanent/false selected state | REMOVED |
| Microtext contrast | PASS |
| Map dark regression | NO |
| Map light readability | PASS |
| Mobile 320 | PASS |
| Mobile 375 | PASS |
| Mobile 390 | PASS |
| Mobile 430 | PASS |
| Desktop 1024 | PASS |
| Desktop 1440 | PASS |
| Article mobile | PASS |
| Article desktop | PASS |
| Files changed | 16 archivos frontend, 2 documentos y evidencias/JSON de esta fase; lista a continuación. |
| UI guideline/skill | `docs/horizai-ui-guidelines.md`; guía local, sin instalación global. |
| Provider calls | 0 |
| Remote writes | 0 |
| lint | PASS |
| TypeScript | PASS |
| build | PASS |
| git diff --check | PASS |

### Archivos de esta fase

- `app/globals.css`
- `app/layout.tsx`
- `app/noticias/[slug]/page.tsx`
- `app/noticias/[slug]/not-found.tsx` (nuevo)
- `components/hero/hero-header.tsx`
- `components/hero/hero.tsx`
- `components/hero/tech-globe.tsx`
- `components/maps/global-intelligence-map/global-intelligence-map.tsx`
- `components/news/article/news-article-page.tsx`
- `components/news/article/article-navigation.tsx` (nuevo)
- `components/news/featured/featured-stories-section.tsx`
- `components/news/featured/featured-story-card.tsx`
- `components/news/latest/latest-news-item.tsx`
- `components/news/latest/latest-news-section.tsx`
- `components/ui/theme-toggle.tsx`
- `components/ui/theme-initializer.tsx` (nuevo)
- `docs/horizai-ui-guidelines.md` (nuevo)
- `docs/ui-refinement-atlas-editorial.md` (nuevo)
- `artifacts/ui-refinement-atlas-editorial.json` (nuevo)
- `artifacts/ui-refinement/` (capturas, medidas y logs nuevos)

## STOP

Siguiente paso: **revisión visual humana de Diego**. No se ejecutó pipeline, scheduler, migración, escritura remota, publicación, deploy ni commit. Las peticiones de lectura de datos públicos y assets cartográficos durante render/build no son llamadas a proveedores de modelos ni escrituras remotas.
