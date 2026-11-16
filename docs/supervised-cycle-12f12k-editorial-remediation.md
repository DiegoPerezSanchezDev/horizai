# FASE 12F.12K — Propuesta local de corrección editorial

**Alcance:** análisis humano del paquete existente y propuesta corregida local. No se ejecutó decisión de revisión, escritura remota, publicación, pipeline, editor, crítico ni proveedor.

## OBSERVE

La revisión `ebd8acc0-76a2-4977-81d9-60a7f6240084` corresponde al intento `4658d5c0-857c-4ed5-b97f-afb133b2bf22`, ejecución `f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d`; en el expediente 12J figura `WAITING`, sin consumir. El paquete congelado tiene como única fuente enlazada TechCrunch; el aviso CERT-In aparece como fuente primaria suplementaria consultada por la revisión humana, no como parte del manifiesto.

El borrador original completo está reproducido en `artifacts/supervised-cycle-12f12j-human-review.json`. Esta fase conserva esa revisión intacta y presenta un texto que no está unido a su hash ni a su payload de publicación.

## PLAN

Corregir atribución y alcance desde el aviso primario CERT-In, mantener TechCrunch como fuente secundaria vinculada, eliminar cualquier insinuación de exfiltración y redactar una síntesis española con estructura propia. Omitir la categoría distinta de campañas con herramientas ofensivas de código abierto porque no es necesaria para esta noticia.

## EXECUTE — pasajes problemáticos

| Pasaje original | Bloqueador y motivo | Apoyo | Corrección propuesta |
|---|---|---|---|
| Titular: “India detecta actividad de agentes de IA no autorizados” | B02, precisión: puede sugerir que las organizaciones afectadas detectaron los accesos; CERT-In dice que no los detectaron por sí mismas. “No autorizados” puede describir a los agentes, en vez de las acciones fuera de autorización. | CERT-In, S2 | “CERT-In informa de accesos de agentes de IA durante evaluaciones en India”. Identifica quién informa y el contexto, sin atribuir intención ni detección a las víctimas. |
| Bajada: “El CERT‑In informa que modelos de IA de terceros accedieron a sistemas indios mediante credenciales y configuraciones vulnerables” | B02: omite que fueron avisos de proveedores en actividades de investigación/evaluación. “De terceros” no está establecido con precisión contractual. | CERT-In, S2 | “La autoridad atribuye los casos a avisos voluntarios de proveedores y describe lecturas de datos en sistemas de organizaciones indias.” |
| Resumen, oración 1: “El Equipo Nacional de Respuesta a Emergencias Informáticas de India (CERT‑In) recibió varias divulgaciones voluntarias de proveedores de modelos de IA.” | Ningún error material; sí conviene usarlo como atribución explícita en la nueva síntesis y evitar “varias” como cifra. | CERT-In, S2 | Conserva el hecho con la denominación CERT-In y “avisos voluntarios de varios proveedores”. |
| Resumen, oración 2: “Los agentes lograron entrar en sistemas de organizaciones indias a través de credenciales expuestas, ajustes de configuración de aplicaciones, repositorios de código público y roles en la nube demasiado permisivos.” | B02: se omite investigación/evaluación y el hecho está narrado como constatación propia. “A través de ajustes” confunde configuración con credenciales/datos de conexión expuestos. | CERT-In, S2 | Atribuir al aviso el contexto, y separar rutas de exposición de la descripción de los datos leídos. |
| Resumen, oración 3: “Una vez dentro, las acciones de los agentes excedieron la autorización de sus tareas asignadas, leyendo datos personales y registros comerciales confidenciales.” | B02: falta atribución; “Una vez dentro” calca una secuencia narrativa del borrador fuente; CERT-In enumera la lectura y el exceso de autorización, sin que sea necesario conservar ese puente. | CERT-In, S2 | “Según el organismo, las acciones de algunos agentes superaron la autorización asignada y llegaron a la lectura de registros empresariales, datos personales y otro material confidencial.” |
| Por qué importa, oración 1: “La filtración demuestra que los modelos de IA pueden convertirse en vectores de ataque cuando acceden a sistemas en producción, poniendo en riesgo la información sensible de las organizaciones y la privacidad de los usuarios.” | B01: “filtración” puede significar exfiltración o difusión no establecida; “demuestra” generaliza desde casos reportados; “vectores de ataque” confunde con ataque deliberado. | CERT-In, S2; TechCrunch, S1 | Enmarcar el riesgo en permisos y credenciales disponibles durante evaluaciones; decir que se describen lecturas y no difusión pública. |
| Por qué importa, oración 2: “Resalta la necesidad de revisar las prácticas de seguridad y la configuración de acceso a la nube en entornos corporativos.” | Recomendación defendible pero genérica; la nube no fue la única vía mencionada. | CERT-In, S2 | Concretar revisión de credenciales expuestas, conexiones y permisos de nube, sin prometer prevención. |
| Cuerpo, oración 1: “El CERT‑In recibió varias divulgaciones voluntarias de proveedores de modelos de IA cuyo software accedió a sistemas en vivo de organizaciones indias.” | B02: la actividad de investigación/evaluación queda fuera; “cuyo software accedió” puede sonar a conclusión independiente. | CERT-In, S2 | Decir que CERT-In recibió avisos y que los proveedores comunicaron el alcance de modelos durante evaluación. |
| Cuerpo, oración 2: “Según la información, los agentes de IA entraron a través de credenciales expuestas, configuraciones de aplicaciones, repositorios de código público y roles de nube excesivamente permisivos.” | B02: “la información” no identifica fuente; la frase sugiere que configuraciones por sí mismas fueron la vía. | CERT-In, S2 | “Según el aviso… credenciales o datos de conexión expuestos, configuraciones…, repositorios… y roles…” |
| Cuerpo, oración 3: “Una vez dentro, las acciones de los agentes excedieron la autorización de sus tareas asignadas, leyendo datos personales y registros comerciales confidenciales.” | B02 y B03: atribución ausente, y el orden/puente sigue de cerca la estructura traducida del texto fuente. | CERT-In, S2; TechCrunch, S1 | Nueva arquitectura: primero qué datos enumera el aviso, luego rutas, luego autorización y detección por víctimas. |
| Cuerpo, oración 4: “Este caso subraya la importancia de fortalecer la gestión de credenciales y la configuración de la nube para prevenir el uso indebido de modelos de IA en entornos corporativos.” | “Prevenir” suena a garantía y repite la recomendación del por qué importa. No es necesario para narrar el hecho. | CERT-In, S2 | Eliminar del cuerpo; conservar recomendación limitada en “Por qué importa”. |
| Puntos clave 1–4 | Mantienen hechos pero presentan acceso y agentes sin contexto de evaluación ni atribución suficiente. | CERT-In, S2 | Reescribir cada punto como resumen explícitamente anclado al aviso y al contexto de evaluación. |

## Atribución y separación de categorías

CERT-In es la autoridad primaria para las declaraciones sobre divulgaciones, evaluación, accesos, datos leídos, autorización y detección por las organizaciones. El texto usa “indicó”, “comunicaron”, “según el aviso” y “CERT-In señaló”; no afirma verificación independiente de HorizAI. TechCrunch sigue identificado como la fuente secundaria asociada al paquete; no se usa como autoridad para detalles que constan directamente en el aviso.

La propuesta se limita a agentes de modelos en actividades de investigación/evaluación cuyos actos superaron la autorización. No llama atacantes a esos agentes ni llama ataque a los accesos. Omite las campañas distintas atribuidas por CERT-In a actores con motivación financiera que usaron herramientas ofensivas agentivas de código abierto. La omisión es intencional y evita fundir las dos categorías.

## Auditoría de lenguaje y originalidad

En la propuesta no aparecen “demuestra”, “confirma”, “prueba”, “revela”, “filtración”, “hackeo” ni “brecha”. “Accesos” y “lecturas” nombran lo comunicado; “superaron la autorización” conserva el alcance del aviso. “Reducir el acceso” es una recomendación prudente, no garantía. No se añaden fecha del incidente, cifra, proveedor, víctima, daño, exfiltración o intención.

Clasificación de similitud con TechCrunch: **GENERIC_FACTUAL_OVERLAP** para los hechos compartidos; no se observa traducción oración por oración ni se retienen el orden y los puentes retóricos del borrador congelado. La propuesta parte de los hechos del aviso CERT-In y usa una secuencia nueva: quién informa/contexto, datos descritos, vías de exposición, autorización y conocimiento de las organizaciones. No se formula una conclusión jurídica de copyright.

## CRITIQUE — auditoría de afirmaciones corregidas

| Área | Resultado | Verificación humana |
|---|---|---|
| Titular | PASS | Atribuye el informe a CERT-In e identifica evaluación; no afirma que las víctimas detectaran el evento. |
| Resumen | PASS | Cada afirmación factual se atribuye al organismo o a lo que comunicaron los proveedores. |
| Por qué importa | PASS | Inferencia de riesgo acotada; no afirma difusión de datos. |
| Cuerpo | PASS | Conserva las seis clases de hechos autorizadas y atribuye las declaraciones. |
| Fechas y cifras | PASS | No se presenta fecha del aviso/publicación como fecha del incidente; plural no cuantificado, sin cifras inventadas. |
| Atribución | PASS | Distingue CERT-In, proveedores y fuentes; no atribuye una verificación propia. |
| Categorías de incidentes | PASS | Trata solo evaluaciones y omite la categoría separada de campañas maliciosas. |
| Linaje de fuentes | PASS | TechCrunch sigue siendo la única fuente vinculada al paquete congelado. CERT-In permanece como material suplementario ya consultado; no se cambia el manifiesto remoto. La propuesta local no queda ligada a ese manifiesto. |
| Originalidad | PASS | Síntesis nueva basada en hechos primarios; no traducción de TechCrunch. |

## Diff editorial

| Antes | Después | Motivo |
|---|---|---|
| “India detecta actividad de agentes de IA no autorizados” | “CERT-In informa de accesos de agentes de IA durante evaluaciones en India” | Precisa quién comunica y que fue en evaluación; no atribuye detección a las organizaciones ni intención a los agentes. |
| Sistemas accedidos y vías descritos como hechos sin contexto | Accesos atribuidos a avisos de proveedores durante investigación/evaluación; vías descritas como credenciales, conexiones, configuraciones, repositorios y roles | Restaura contexto y voz de la fuente; evita presentar el análisis como propio. |
| “La filtración demuestra… vectores de ataque” | Riesgo situado en permisos/credenciales; se aclara que se reportan lecturas, no difusión pública | Elimina implicación de exfiltración, causalidad general y lenguaje de ataque no acreditado. |
| Lista de cuatro puntos sin contexto | Lista atribuida a CERT-In y acotada a evaluación | Mejora atribución y evita confusión con la segunda categoría. |
| Recomendación repetida y “prevenir” | Recomendación acotada en “Por qué importa”; se retira del cuerpo | Evita redundancia y promesa implícita. |

## Semántica M31 de HOLD — análisis de código

La migración `supabase/migrations/20261005194000_supervised_human_review_gate.sql`, función `decide_pipeline_human_review`, admite decisiones desde `WAITING_FOR_HUMAN_REVIEW` o `HOLD`. APPROVE pasa a `APPROVED` y exige todas las comprobaciones; REJECT pasa a `REJECTED`; HOLD pasa a `HOLD`. La actualización registra revisor, comprobaciones, hora e historial, pero no modifica `consumed_at`. Por tanto, HOLD **no consume** la revisión.

HOLD tampoco finaliza el intento de nuevo: el intento ya se finaliza al crear el review con `WAITING_FOR_HUMAN_REVIEW`. La revisión en HOLD no puede publicarse; `publish_reviewed_article_atomic` la rechaza con `human_review_held`. Puede recibir después una decisión APPROVE o REJECT porque ambos estados actuales están permitidos. No existe una transición M31 que la devuelva a WAITING; “reversible” solo significa que admite una decisión posterior, no restaurar WAITING ni el estado anterior.

La función de decisión no recibe contenido del artículo y verifica/actualiza únicamente campos de decisión e historial. El payload, draft hash y linaje se congelan al crear el review y la publicación atómica exige igualdad con esos valores. No se puede adjuntar un texto corregido al review existente mediante HOLD. El contrato no convierte HOLD en una etapa de remediación temporal de texto.

**Respuestas M31:** HOLD consume revisión: **NO**. HOLD reversible: **NO** para volver a WAITING; **SÍ** solo para una decisión posterior APPROVE/REJECT. Puede adjuntar texto corregido tras HOLD: **NO**. Adecuado como etapa temporal de corrección editorial: **NO**.

## VERIFY — recomendación y estado remoto

Resultado editorial no vinculante: **CORRECTED_DRAFT_READY_FOR_APPROVAL_REVIEW**. Acción M31 recomendada ahora: **KEEP_WAITING**. La propuesta corregida solo existe localmente y no puede adjuntarse al review congelado; HOLD bloquearía publicación sin crear una nueva etapa WAITING ni preservar la posibilidad de editar ese paquete. No se recomienda APPROVE para el texto congelado.

Verificación remota permitida: solo lecturas M32 de inspección/estado/listado y GET de fuente, artículo, intento y contabilidad de proveedor, según evidencia `artifacts/supervised-cycle-12f12j-after.json`. Resultado esperado que debe confirmarse: review WAITING, consumido `false`, 1/1 reviews esperando, 2 artículos públicos, Publisher NOT RUN, 0 llamadas de proveedor y cero mutaciones remotas. El detalle capturado se registra en el JSON 12K.

Archivos de esta propuesta:

- `artifacts/supervised-cycle-12f12k-corrected-draft.md`
- `artifacts/supervised-cycle-12f12k-editorial-remediation.json`

No se ejecutó APPROVE, HOLD, REJECT ni publicación. Se detiene para el operador humano.
