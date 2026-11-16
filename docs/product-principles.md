# Principios de producto y modo de trabajo de HorizAI

Este documento es la referencia permanente para cualquier intervención en HorizAI. Su propósito es conservar el criterio de producto, evitar cambios locales sin contexto y mantener una experiencia coherente a medida que evoluciona la aplicación.

Toda tarea debe seguir este ciclo:

> **OBSERVE → PLAN → EXECUTE → CRITIQUE → VERIFY**

La existencia de este proceso no amplía el alcance de una tarea. Entender el contexto sirve para corregir la causa real y prevenir regresiones, no para rediseñar áreas no relacionadas.

## 1. Identidad del producto

HorizAI debe sentirse como:

- una plataforma de inteligencia global;
- un medio tecnológico premium;
- una herramienta de exploración;
- un producto editorial claro y moderno.

HorizAI no debe sentirse como:

- un blog genérico;
- un dashboard empresarial saturado;
- un GIS técnico;
- una landing de startup;
- una interfaz gaming.

### Principios innegociables

1. **Information first.** La información y su comprensión tienen prioridad sobre el ornamento.
2. **Global perspective.** La escala, el lenguaje y las herramientas deben transmitir una visión global.
3. **Premium but readable.** El producto puede ser sofisticado sin sacrificar claridad, contraste ni comodidad de lectura.
4. **Data without dashboard overload.** Los datos deben aportar contexto, no convertir cada superficie en un panel de métricas.
5. **Blue is accent, not decoration.** El azul eléctrico destaca conceptos, estados y acciones clave; no rellena espacio sin propósito.
6. **Maps are tools, not background imagery.** Los mapas deben permitir explorar o comprender, nunca actuar como simple decoración.
7. **Mobile is a separate composition, not a compressed desktop.** La versión móvil debe ordenar y priorizar el contenido según su propio contexto.
8. **Avoid unnecessary UI.** No añadir controles, capas, badges, contenedores o texto si no resuelven una necesidad real.
9. **Prefer hierarchy over density.** La prioridad debe entenderse por composición, escala, espacio y tipografía, no por acumulación.
10. **Every component must justify its space.** Cada componente debe aportar información, orientación o una acción útil.
11. **Keep interaction subtle and intentional.** Movimiento, hover, transición y feedback deben ser discretos, coherentes y funcionales.
12. **Preserve working architecture.** La arquitectura existente se conserva salvo que exista una razón clara, demostrable y dentro del alcance para cambiarla.

## 2. Antes de actuar: definir la tarea real

Antes de modificar código, responder de forma explícita —aunque sea en notas de trabajo breves— a estas preguntas:

- ¿Qué objetivo de producto persigue la tarea?
- ¿Qué recorrido, componente, estado o capa del sistema está afectado?
- ¿Qué reglas visuales o de UX son innegociables en este caso?
- ¿El problema descrito existe realmente y se puede reproducir?
- ¿Cuál es la causa probable y qué efectos laterales puede tener?
- ¿Qué cambio es necesario y qué cambios quedarían fuera de alcance?

Una petición como «arregla X» obliga a entender por qué falla X, revisar su contexto y corregir el problema real. No autoriza a cambiar media aplicación.

## 3. Proceso de trabajo

### 3.1 OBSERVE

No empezar editando código. Primero:

- inspeccionar la aplicación y reproducir el comportamiento;
- localizar el componente y comprender sus estados, datos y dependencias;
- revisar la composición responsive, incluidos los puntos de ruptura próximos al problema;
- revisar dark mode y light mode;
- revisar navegación, rutas, enlaces y retorno cuando sean relevantes;
- comprobar consola, overflow y comportamiento interactivo;
- distinguir un defecto real de una preferencia subjetiva;
- identificar riesgos y posibles efectos colaterales;
- consultar la documentación de la versión instalada de las dependencias antes de usar o cambiar sus APIs. Para Next.js, leer la guía relevante en `node_modules/next/dist/docs/` antes de escribir código.

El resultado de OBSERVE debe ser una descripción breve del objetivo, el problema comprobado, la causa o hipótesis y el alcance afectado.

### 3.2 PLAN

Clasificar cada hallazgo antes de actuar:

| Nivel | Definición | Acción |
| --- | --- | --- |
| `CRITICAL` | Rompe una función, bloquea un recorrido, pierde contenido, impide acceder o causa una regresión grave. | Corregir. |
| `IMPORTANT` | Daña de forma clara la comprensión, la jerarquía, la accesibilidad, el responsive o la coherencia del producto. | Corregir dentro del alcance. |
| `POLISH` | Mejora perceptible, concreta y de bajo riesgo, sin abrir un rediseño lateral. | Hacer solo si el beneficio es claro. |
| `IGNORE` | Preferencia subjetiva, cambio no demostrado, problema ajeno al alcance o coste/riesgo superior al beneficio. | No tocar. |

El plan debe indicar:

- qué se va a cambiar y por qué;
- qué se conservará deliberadamente;
- qué archivos o superficies podrían verse afectados;
- cómo se verificará el resultado.

Solo se modifican hallazgos `CRITICAL`, `IMPORTANT` y, con criterio, `POLISH`. Los hallazgos `IGNORE` se documentan si aportan contexto, pero no se implementan.

### 3.3 EXECUTE

Durante la implementación:

- aplicar el cambio mínimo que resuelva el problema real;
- respetar la arquitectura y los patrones existentes;
- reutilizar componentes, estilos, tokens y utilidades antes de crear alternativas;
- evitar duplicación y soluciones paralelas;
- no añadir dependencias salvo necesidad real y justificada;
- mantener intactas las zonas no relacionadas con la tarea;
- preservar los comportamientos que ya funcionan;
- mantener el alcance trazable respecto al plan.

Si aparece un problema nuevo que exige una intervención materialmente distinta, detener la expansión automática del alcance y replantear el plan.

### 3.4 CRITIQUE

Después de implementar, volver a observar el área como producto terminado:

- comprobar que se resolvió la causa y no solo el síntoma;
- comparar el resultado con el objetivo de producto;
- buscar regresiones visuales, funcionales y de contenido;
- revisar estados vacíos, carga, error, hover, focus y contenido extremo cuando apliquen;
- confirmar que el cambio sigue siendo el mínimo necesario;
- eliminar complejidad, UI o código que no justifique su presencia.

Pregunta de salida: **¿el cambio mejora claramente HorizAI sin degradar otra parte?** Si la respuesta no es clara, simplificar o revertir la parte dudosa.

### 3.5 VERIFY

La verificación forma parte de la implementación, no es opcional. Ejecutar siempre:

```bash
npm run lint
npm run build
```

Además, comprobar en las superficies afectadas:

- ausencia de errores y warnings relevantes en consola;
- ausencia de overflow horizontal o recortes involuntarios;
- responsive en los tamaños de referencia;
- dark mode y light mode;
- navegación y enlaces;
- el estado específico afectado por la tarea;
- accesibilidad básica: foco visible, orden comprensible, etiquetas y contraste cuando apliquen.

Si una comprobación no puede ejecutarse, dejar constancia explícita de cuál fue, por qué y qué riesgo queda pendiente. No presentar como verificado lo que solo se ha inferido.

## 4. Reglas visuales y de experiencia

### Hero

- El H1 debe dominar la jerarquía.
- El globo complementa el mensaje; no compite con él.
- Las métricas son compactas y secundarias al mensaje principal.
- En desktop, la siguiente sección no debe aparecer dentro del primer viewport.
- El hero debe seguir funcionando en desktop pequeño, sin colisiones ni pérdida de jerarquía.
- En móvil se usa una composición propia, no una reducción proporcional del desktop.

### Mapa

- Debe existir como una única herramienta global.
- Mantener las vistas `Nodos` y `Calor`.
- El mapa es el protagonista de su superficie.
- Los paneles y controles no deben ocultar innecesariamente el canvas.
- Los filtros deben ser compactos, legibles y fáciles de operar.
- Evitar patrones y densidad propios de un GIS tradicional.
- `Nodos` comunica conexiones y hubs.
- `Calor` comunica intensidad y concentración.

### Historias destacadas

- Deben ser visuales, compactas y editoriales.
- Evitar cards excesivamente altas o con espacio sin función.
- En móvil, usar carrusel cuando mejore la exploración y no oculte la existencia de más contenido.

### Últimas noticias

- Priorizar lectura y escaneo rápidos.
- Usar filas compactas y jerarquía clara.
- La metadata es secundaria al titular.
- Evitar una lista infinita que diluya la selección editorial.
- Mantener la acción `Ver más noticias`.

### Artículos

- La lectura debe ser cómoda y sostenida.
- El titular debe tener presencia y jerarquía.
- `POR QUÉ IMPORTA` debe ser visible y fácil de localizar.
- Las fuentes deben ser claras y trazables.
- El cuerpo debe sentirse editorial, no como una colección de widgets.
- Las relacionadas deben ser compactas y no competir con el artículo.

### Color y temas

- Navy y negro forman la base del modo oscuro.
- El azul eléctrico es un acento, no una superficie decorativa dominante.
- Evitar saturación cromática y brillo sin función.
- Reservar el azul para conceptos, señales, acciones y datos clave.
- Diseñar light mode de forma intencional; no tratarlo como una inversión automática del dark mode.
- Mantener legibilidad, contraste y jerarquía en ambos temas.

## 5. Responsive

Validar siempre estos tamaños de referencia:

| Contexto | Resolución |
| --- | --- |
| Desktop grande | `1920 × 1080` |
| Desktop estándar | `1440 × 900` |
| Portátil | `1366 × 768` |
| Desktop pequeño | `1280 × 800` |
| Tablet horizontal / viewport estrecho | `1024 × 768` |
| Tablet vertical | `768 × 1024` |
| Móvil alto | `390 × 844` |
| Móvil compacto | `375 × 812` |

Prestar especial atención a:

- header móvil y acceso a navegación;
- filtros horizontales y su scroll/ajuste;
- carruseles, indicadores y affordance de desplazamiento;
- escala, posición y recorte del globo;
- canvas, controles y paneles del mapa;
- altura, ritmo y contenido de las cards;
- ancho de lectura y jerarquía de artículos;
- composición y cierre del footer.

No basta con revisar los extremos desktop/móvil: los tamaños intermedios revelan muchas de las colisiones y pérdidas de jerarquía.

## 6. Criterios de aceptación

Una tarea está terminada solo cuando:

- el objetivo de producto y el problema real están identificados;
- los hallazgos fueron clasificados y el alcance está justificado;
- la solución corrige la causa con el cambio mínimo necesario;
- no se rediseñaron ni reestructuraron áreas ajenas;
- se conservaron arquitectura y comportamientos existentes salvo razón explícita;
- el resultado respeta las reglas visuales y de UX aplicables;
- los estados y recorridos afectados funcionan en dark y light;
- no hay overflow, errores de consola ni regresiones conocidas en el área afectada;
- se validaron los tamaños responsive de referencia;
- `npm run lint` y `npm run build` finalizan correctamente;
- cualquier limitación de verificación queda declarada con claridad;
- la entrega enumera archivos modificados, resultado y verificaciones realizadas.

Para tareas exclusivamente documentales, las revisiones visuales e interactivas pueden declararse **no aplicables** si no se modificó ningún recurso ejecutable o visual; `lint` y `build` se mantienen como control de integridad del repositorio.

## 7. Qué no debe hacerse

- No empezar a cambiar código antes de observar y definir el problema.
- No asumir que una instrucción local describe toda la causa.
- No usar el contexto como excusa para ampliar el alcance.
- No rediseñar áreas no relacionadas.
- No añadir UI para llenar espacio o aparentar funcionalidad.
- No convertir información editorial en un dashboard saturado.
- No usar azul, glow, gradientes o animación como decoración gratuita.
- No convertir el mapa en fondo visual ni en un GIS denso.
- No comprimir el desktop para obtener la versión móvil.
- No introducir componentes duplicados ni abstracciones prematuras.
- No añadir dependencias por conveniencia cuando el proyecto ya ofrece una solución.
- No reemplazar arquitectura estable sin una causa demostrable.
- No ocultar fallos de verificación ni afirmar que algo fue probado cuando no lo fue.
- No mezclar refactors oportunistas con una corrección acotada.

## 8. Formato recomendado para futuras intervenciones

Usar esta ficha breve para mantener trazabilidad:

```text
OBJECTIVE
Objetivo de producto y resultado esperado.

OBSERVE
Problema reproducido, contexto, causa/hipótesis, dependencias y riesgos.

PLAN
CRITICAL: ...
IMPORTANT: ...
POLISH: ...
IGNORE: ...
Alcance elegido y elementos que se preservan.

EXECUTE
Cambios mínimos realizados.

CRITIQUE
Resultado de la segunda revisión y simplificaciones aplicadas.

VERIFY
Lint, build, consola, responsive, dark/light, navegación y estados afectados.
Limitaciones pendientes, si las hay.
```

La ficha puede condensarse en tareas pequeñas, pero el razonamiento y las comprobaciones que representa no deben omitirse.
