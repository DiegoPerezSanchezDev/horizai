# Ámbito editorial y política de fuentes (P0-a)

**Estado: BORRADOR v3 con todas las decisiones D1–D5 incorporadas (2026-11-06). Pendiente solo de la aprobación final del CEO.**
Alcance: solo documento; no cambia código, configuración, proveedores ni scheduler.

Decisiones tomadas por el CEO: D1 = A, D2 = español, D2b = disponibilidad amplia (sin cifra), D4 = el CEO con ayuda de Claude. Los puntos aún marcados **[DECIDIR]** siguen abiertos. Los valores propuestos son recomendaciones, no hechos.

## 1. Propósito

HorizAI selecciona cada día un número reducido de noticias de IA y tecnología de cualquier país y explica por qué importan. Funciona como **panel de descubrimiento**: el mérito de cada noticia, investigación o hallazgo pertenece a su fuente original, y HorizAI lleva al lector hasta ella. Es un producto de **selección curada con revisión humana**, no un agregador ni un servicio de cobertura exhaustiva.

## 2. Ámbito editorial

**[DECIDIDO D1] Opción A: medio de IA y tecnología con alcance global.** Solo eventos de IA y tecnología; la geografía es una dimensión de análisis, no un filtro temático.

**[DECIDIDO D1b]** Dentro del ámbito entran estas áreas:

- IA (modelos, investigación, productos, empresas)
- Hardware (chips, centros de datos, dispositivos)
- Robótica
- Ciberseguridad
- Regulación tecnológica
- Impacto económico de la IA

Consecuencia: el criterio de «interesante» se evalúa dentro de esas áreas. Los casos fronterizos (p. ej. tecnología sin relación con IA, o economía general) se resolverán con ejemplos en P0-b; hasta entonces se tratan como candidatos de baja prioridad y no se descartan por defecto.

### 2.1 Qué es «interesante» (criterios propuestos)

Un evento es candidato si cumple al menos dos:

1. **Impacto:** afecta a muchas personas, a un mercado o a una decisión pública relevante.
2. **Novedad:** aporta un hecho nuevo, no una repetición de un evento ya publicado.
3. **Verificabilidad:** existe al menos una fuente primaria o dos fuentes independientes.
4. **Alcance:** relevante fuera de su país de origen, o ilustra una tendencia global.

### 2.2 Qué se descarta siempre

- Contenido sin fuente identificable o sin fecha válida (ver `docs/freshness-policy.md`).
- Rumores, opinión sin hechos nuevos, contenido promocional.
- Eventos ya cubiertos sin novedad material.
- Contenido que no podemos atribuir ni resumir sin riesgo de derechos (sección 4).

## 3. Cobertura geográfica

- **Sin cuota por país ni por día.** La capacidad gratuita limitada y la selección curada hacen inviable prometer cobertura diaria de todos los países.
- El **país de la noticia** puede diferir del **país de la fuente**; el sistema debe registrar ambos.
- La ausencia de noticias de un país un día concreto es un resultado legítimo, no un fallo.
- La diversidad se mide como **objetivo semanal observable** (países y regiones distintos publicados), solo como indicador. **[DECIDIR D3]** si se publica ese indicador o es interno.
- **[DECIDIDO D2]** Idioma de publicación: español, mediante el agente traductor. El título original y el enlace a la fuente en su idioma permanecen visibles.

## 4. Política de fuentes, atribución y derechos

**[DECIDIDO D4]** La revisión de esta política la hace el CEO con ayuda de Claude. Aviso de límite: Claude no es abogado y no puede certificar el cumplimiento legal (derechos de autor, términos de cada fuente, normativa por país). El objetivo del CEO es «todo legal»; por eso este documento adopta el criterio más conservador y deja constancia de que, si el volumen o el riesgo crecen, conviene una consulta profesional puntual.

Principio rector: **HorizAI es un panel de descubrimiento. El mérito es de la fuente; nosotros dirigimos tráfico y atención hacia ella.**

1. **Resumen propio y breve, nunca reproducción.** El texto es redacción original basada en hechos; no se copian párrafos ni titulares enteros. La traducción al español de contenido ajeno no se publica como texto completo, solo como resumen.
2. **Atribución prominente a la fuente original.** Cada artículo muestra, bien visible y no solo al final: nombre del medio o autor, fecha, **enlace directo a la noticia original** y, si la noticia se basa en una investigación, informe o paper, enlace a ese documento y a su autoría (organización o equipo).
3. **Lenguaje de mérito.** Los hallazgos se redactan atribuidos («según X», «X publicó», «el equipo de Y descubrió»); HorizAI no presenta como propia ninguna investigación ni revelación.
4. **Sin sustituir la visita.** El resumen debe invitar a leer el original y no sustituirlo; no se reproduce lo esencial de la pieza de pago o exclusiva.
3. **Fuentes por nivel de confianza.** Primaria (organismo, empresa, documento oficial) > agencia o medio con trayectoria > fuente secundaria. El nivel se registra por fuente.
4. **Corroboración.** Afirmaciones factuales críticas necesitan fuente primaria o dos fuentes independientes. Si hay desacuerdo entre fuentes, el artículo lo dice o no se publica.
5. **Respeto a las condiciones de cada fuente.** Respetar `robots.txt`, términos de uso y licencias. Una fuente que lo prohíba se excluye.
6. **Incertidumbre explícita.** Lo no confirmado se redacta como tal.
7. **Sin datos personales innecesarios.** No se publican datos personales que no sean indispensables para entender el hecho.

## 5. Correcciones y retirada

1. Una corrección se publica en el propio artículo, con fecha y descripción del cambio; no se edita en silencio.
2. Un error factual grave puede motivar la **retirada** del artículo, con registro interno del motivo.
3. Existe un canal de contacto visible para señalar errores (la página `app/contacto` existe; su idoneidad como canal de correcciones **no se ha verificado** en este borrador).
4. **[DECIDIDO D5]** Plazo de atención a una incidencia: se resuelve el mismo día o, como máximo, al día siguiente (hasta 2 días naturales). Si el reclamo es de un titular de derechos o es un error grave, el artículo se retira en ese mismo plazo, y la retirada puede ser preventiva mientras se investiga. El responsable de atender el canal es el CEO.
5. El repositorio ya contiene un ciclo de remediación factual (`docs/factual-remediation-lifecycle-12c2b1.md` y relacionados); este borrador no lo modifica, y habrá que alinear con él el flujo de correcciones públicas.

## 6. Revisión humana

- Ningún artículo se publica sin aprobación humana mientras dure la fase supervisada (flujo aviso → panel → OK → publicación).
- **[DECIDIDO D2b]** El CEO dispone de tiempo amplio para revisar, sin cifra fija. La revisión humana deja de ser el límite práctico; el volumen lo limita la **capacidad gratuita de los modelos** y la calidad.
- Volumen inicial: hasta **3 candidatas** y **2 publicaciones** por ejecución, coherente con los topes del runtime.
- **Escalado condicionado:** si se incorporan más modelos baratos o gratuitos y la calidad se mantiene, se amplía el volumen. Cada ampliación requiere evidencia (evaluación comparada con los mismos casos) y autorización explícita; no es automática.

## 7. Criterios de aceptación de este documento

- Ámbito (D1) e idioma (D2) decididos. ✔
- Definición de «interesante» (sección 2.1) aprobada o ajustada por el CEO.
- Los principios de derechos (sección 4) aprobados por el CEO, con el límite de ayuda no jurídica declarado.
- Política de correcciones con plazo confirmado (D5). ✔
- Pendiente solo: aprobación final del documento completo por el CEO (incluida la definición de «interesante», sección 2.1).
- Este documento queda referenciado desde la evaluación offline de discovery (P0-b), que usará estos criterios para decidir qué es una pérdida legítima de cobertura y qué es un descarte correcto.

## 8. Decisiones pendientes

| ID | Decisión | Propuesta |
| --- | --- | --- |
| D1 | Ámbito editorial | **Decidido: A (IA y tecnología, alcance global)** |
| D1b | Áreas de «IA y tecnología» | **Decidido:** IA, hardware, robótica, ciberseguridad, regulación tecnológica, impacto económico de la IA |
| D2 | Idioma principal | **Decidido: español** |
| D2b | Tiempo de revisión humana | **Decidido: amplio, sin cifra** |
| D3 | Indicador de diversidad geográfica, ¿público o interno? | Interno al inicio |
| D4 | Revisión de derechos y atribución | **Decidido: CEO con Claude**; consulta profesional si crece el riesgo |
| D5 | Plazo de respuesta a correcciones | **Decidido:** mismo día o día siguiente (máx. 2 días naturales) |

## 9. Fuera de alcance

Proveedores, modelos, scheduler, migraciones, CSP, README, cambios de código y activación de cualquier automatización. Esos puntos pertenecen a P0-b, P0-c y P1.
