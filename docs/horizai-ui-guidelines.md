# HorizAI UI — Atlas Editorial

Guía local derivada de la fase UI-02. Complementa [product-principles.md](product-principles.md), que sigue siendo la fuente de verdad. No se instaló una skill global: el repositorio no tenía una convención clara para skills locales.

## Dirección

HorizAI es una publicación de inteligencia artificial global en español, con contexto y una herramienta real de exploración. La noticia, su explicación y su fuente sostienen la jerarquía. Mantener navy/casi negro, azul eléctrico, globo, temas claro/oscuro y las tipografías existentes.

Usar el azul para acciones, enlaces y señales relevantes. Reservar glow para identidad, acción principal, globo y datos del mapa. Preferir texto, espacio y reglas finas a contenedores adicionales. Inter y Manrope siguen cubriendo interfaz, lectura y titulares; JetBrains Mono se reserva principalmente para fechas, cantidades y etiquetas técnicas.

## Portada y responsive

- Mantener una promesa breve y visible en español, junto a la noticia principal.
- Desktop: marca a la izquierda, navegación centrada mediante tres columnas simétricas y tema a la derecha. Medir el centro respecto al viewport útil, descontando la barra de desplazamiento.
- Mobile: componer encabezado, noticia, acciones, globo y datos en su propio orden. Evitar comprimir el desktop.
- El globo decorativo debe conservar transparencia, espacio para órbitas y halo y un escenario que contenga su tamaño real. No disimular recortes con blur.
- Ajustar movimiento y contraste por tema. Los callouts del globo son editoriales; su posición no representa coordenadas.
- Validar 320, 375, 390, 430, 768, 1024 y 1440 px; ampliar la matriz cuando lo requiera el cambio.

## Historias

- Con una o dos historias, usar el ancho disponible; la cuadrícula depende del número real de elementos.
- Separar categoría, región, titular, resumen, fecha y fuente mediante ritmo y espaciado explícitos.
- Si falta `image_url`, mostrar una composición de texto deliberada. No crear un bloque vacío, imagen ficticia o placeholder decorativo dominante.
- Si hay imagen real, conservarla con dimensiones reservadas y texto alternativo adecuado al contenido.
- Las últimas noticias forman un índice editorial continuo, con divisores y filtros. Evitar paneles gigantes, tablas visuales y estados que parezcan seleccionados de forma permanente.
- Los estados vacío/error deben explicar lo que ocurre. No duplicar noticias para llenar espacio.

## Artículos

- `/noticias/[slug]` utiliza una acción mínima de regreso; no incorpora navegación global ni toggle visible.
- La preferencia de tema se restaura desde el layout, también al navegar y en estados no disponibles.
- El titular entra pronto en el viewport. Conservar resumen, fecha, tiempo de lectura, ancho cómodo y trazabilidad de fuentes.
- “Por qué importa” es un bloque abierto con señal fina y encabezado localizable.
- Sin artículos relacionados, ofrecer rutas reales a las noticias recientes y al mapa.

## Mapa

Mantener MapLibre, carga diferida, worker, Nodos/Calor, filtros, coordenadas y panel de historias. Preservar el tratamiento oscuro. En claro, mejorar legibilidad sin sustituir la cartografía ni fabricar actividad.

Indicar ventana temporal, publicaciones y ubicaciones disponibles. Explicar que cobertura editorial y actividad mundial no son equivalentes. El mapa es una herramienta; el globo del hero es decorativo.

## Accesibilidad y cierre

Texto pequeño normal: contraste mínimo 4,5:1 sobre su superficie efectiva. No volver azul todo el texto secundario. Revisar superficies compuestas y estados hover/focus; un resultado cercano al umbral no debe redondearse a PASS.

Mantener foco visible, orden de encabezados y etiquetas accesibles. Controles táctiles de las áreas intervenidas: objetivo de 44 px. Respetar `prefers-reduced-motion`, incluida la navegación del carrusel.

Definition of done:

1. OBSERVE → PLAN → EXECUTE → CRITIQUE → VERIFY, con causa reproducida y alcance explícito.
2. Capturas reales antes/después, con tamaño, tema y posición comprobados.
3. Sin overflow, regresiones conocidas ni errores/warnings de hidratación en los recorridos revisados.
4. Estados con 1, 2, 5 y 10+ historias, filtros, imágenes y ausencia de imagen revisados cuando corresponda.
5. Lint, TypeScript, build, `git diff --check` y pruebas relevantes solicitadas completados; límites de verificación declarados.
6. Documentar archivos y evidencias; detenerse para revisión humana cuando la fase lo requiera.
