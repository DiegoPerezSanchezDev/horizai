# Critic TPM fit remediation — 12C.2B.2a

**Resultado: READY NO — detenido antes de modificar código.** El intento 5 ya está finalizado como `TECHNICAL_FAILURE`. El runner actual solo admite reanudar un intento activo y reinicia en Verifier. Reabrir de forma auditable ese mismo intento requiere una transición/RPC de base de datos. Esta fase prohíbe crear la migración 28, por lo que no se implementó una reanudación ni un nuevo serializador. No hubo solicitudes a proveedores ni escrituras remotas.

## STOP CONDITION

La regla de esta fase dice detenerse si la reanudación necesita un cambio de esquema. La evidencia del código lo confirma:

- `assertFactualRemediationLease` exige `completedAt === null` y `finalState === null`.
- `SupabaseFactualRemediationRepository.assertOwned` exige lo mismo en la fila remota.
- `finalize_pipeline_event_attempt` actualiza solo filas con `completed_at is null`; una fila finalizada no puede volver a estado activo mediante ese RPC.
- Migration 27 solo crea intentos desde Verifier y la clave única permite una sola remediación factual por evento. No existe un RPC de reanudación desde Critic.
- `runFactualRemediation` crea el contexto desde cero y `runEventStages` comienza por Verifier; no carga los cinco checkpoints actuales.

Cambiar solo la validación TypeScript no resolvería la propiedad ni la finalización remotas y saltarse esas guards dejaría un artículo posiblemente publicado bajo un intento que sigue registrado como fallo técnico. Se detuvo la implementación de producto. No se creó migration 28 ni se alteró el estado del intento.

## CURRENT ATTEMPT

- Artículo: `756b0ee0-b5e6-4153-846f-278a12c9afe3`, slug `openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad`.
- Evento: `5138e509-f4c3-4020-9d13-6a6efac99a39`; key `event-30f226d1b8ba5c9eb8af2b65c46db512`.
- Intento de remediación: `a82482be-58d8-4fc6-ac16-946d0906257b`; pipeline run `db368f10-d9c1-4897-b752-b3d2cb156e09`; intento local 2, piloto 5/5.
- Estado de cierre registrado: `TECHNICAL_FAILURE`, etapa `critic`, razón `cost_guard_violation`. Critic no se despachó; no existe su checkpoint. Publisher no se ejecutó.
- Accounting verificado en el artefacto de ejecución 12C.2B.2: 19 llamadas previas + 5 despachadas en este run = 24/30. El contador queda en 5/5 intentos.
- No se creó otro intento en esta fase. La reanudación desde Critic no está soportada por el ciclo de vida actual.

La lectura remota de este turno devolvió `PGRST303`, por lo que no afirmo una nueva confirmación en vivo. La última lectura remota exitosa, recogida en los artefactos de 12C.2B.2, dejó el artículo archivado, el artículo fuera de la vista pública y el recuento público en 2. La validación remota anterior dejó migration 27 aplicada y 28 ausente.

## 9005 TOKEN REPRODUCTION

Se reconstruyó offline el Critic input desde el checkpoint Ranker de este run y se ejecutó el estimador canónico instalado:

```text
promptInputChars = 3,711 system + 10,230 JSON input + 1,413 strict schema = 15,354
estimatedInputTokens = ceil(15,354 / 2) + 128 = 7,805
maxOutputTokens = 1,200
estimatedStageTokenRequirement = 7,805 + 1,200 = 9,005
```

Por tanto, `9005` no son tokens reales medidos por Groq ni solo tokens de entrada. Es una reserva conservadora de entrada calculada con caracteres/2 más 128 tokens de overhead, sumada a la reserva máxima de salida. La solicitud no llegó al proveedor.

La política de pacing bloquea si `estimatedStageTokenRequirement + 128 > 8,000`; el techo estimado despachable es 7.872. El plan actual excede ese techo por 1.133 tokens.

## TOKEN COMPONENTS

| Componente serializado de entrada | Caracteres |
| --- | ---: |
| Instrucciones del sistema Critic v3 | 3.711 |
| JSON del modelo | 10.230 |
| JSON Schema estricto enviado al proveedor | 1.413 |
| Total sometido al estimador | 15.354 |
| Overhead del estimador (tokens) | 128 |
| Reserva máxima de salida | 1.200 |
| Total reservado | **9.005 tokens** |

Desglose del JSON de entrada: `event` 125; `verification` 545; `translation` 723; `editorial` 1.638; `classification` completa 286; `ranking` completo 665; `sources` 230; `sourceEvidence` 1.371; `evidenceCatalog` 4.498; `schemaVersion` 1. El resto hasta 10.230 corresponde a claves, separadores y serialización JSON.

La fuente aporta un extracto limitado a 1.000 caracteres dentro de `sourceEvidence`. El modelo no recibe el objeto raw ni el cuerpo completo. La coordenada geográfica llega dentro del objeto de clasificación; el campo `geo` no se transmite por separado.

## ROOT CAUSE

Clasificación: **`DUPLICATED_EVIDENCE`**. El componente de catálogo ocupa 4.498 caracteres e incluye 2.424 caracteres de previews. Esos previews vuelven a presentar material que ya aparece en los campos de Verifier, Translator, Editor, clasificación, ranking y el extracto de fuente. El duplicado es deliberado para que el modelo resuelva índices de evidencia, pero aquí repite texto además de referencias.

El cálculo de 9.005 también hereda el estimador conservador `chars/2 + 128`; por su naturaleza es una aproximación de capacidad, no un tokenizer del proveedor. No se rebajó el resultado numérico del estimador.

La reserva de salida se mantiene en 1.200. El esquema actual admite hasta 50 hallazgos, cadenas largas y hasta 20 índices por hallazgo. Una fixture sintética válida en los límites del esquema serializa 133.214 caracteres. Los outputs Critic reales disponibles incluyen 33, 45, 106 y 290 tokens; esas muestras pequeñas no justifican bajar la reserva por debajo de la salida válida permitida por el contrato. No se cambió el esquema ni `maxOutputTokens`.

## EVIDENCE DUPLICATION

- Los hechos verificados aparecen en `verification.verifiedFacts` y vuelven a aparecer como previews de catálogo.
- Las parejas `sourceText → translatedText` aparecen en `translation.translatedFacts` y vuelven a aparecer en el catálogo.
- Titular, dek, resumen, `whyItMatters`, cuerpo y puntos clave aparecen en el draft y vuelven a resumirse en entradas del catálogo.
- Los previews de fuente se derivan del mismo extracto acotado entregado en `sourceEvidence`.
- `classification` y `ranking` se pasan como objetos completos al modelo, aunque el razonamiento necesita solo una proyección editorialmente relevante. El modelo sí recibe `sources` mediante una selección explícita de seis campos; no se serializa el objeto raw.
- No se encontró contexto histórico de otros runs ni estructuras de error gigantes en el prompt de Critic.

No se eliminó ninguna evidencia ni se reescribió ningún checkpoint.

## COMPACTION

Proyección mínima propuesta para una fase posterior, aún **no implementada ni validada**: identidad del evento; una fuente con outlet, source/item IDs, URL, título, hash y extracto acotado; envelope de Verifier con estado/confianza, hechos, incertidumbres y contradicciones; pares fuente/traducción; todo el draft editorial para comparar claims; proyección de clasificación con región/coordenadas/categorías/entidades; scores y motivo de ranking; e índices tipados que apunten a esos campos sin repetir sus previews.

Esto preservaría las comparaciones semánticas sin añadir texto de fuente. El nuevo tamaño y la estimación serían nulos hasta que exista un builder ejecutable y probado. No se declara un Critic input compacto ni una reserva menor.

## OUTPUT BUDGET

Reserva antes: 1.200 tokens. Reserva después: 1.200, sin cambios. `criticCurrentGenerationSchema` acepta un máximo de 50 hallazgos; cada objeto permite claims/messages/reasons extensos y hasta 20 índices. La fixture máxima válida creada offline confirma que reducir el presupuesto sin acotar antes el contrato sería inseguro. No se tocó el contrato de salida.

Outputs Critic con telemetría real disponibles en los artefactos: Groq 33 (`groq-full-path-capacity-probe-10g7a4`), 45 (`targeted-critic-publisher-resume-12a2`), y 290/106 (`cloudflare-quality-benchmark-10g7b`, historial Groq). No se atribuyó al Critic el total de salida agregado de un evento completo.

## FACTUAL COVERAGE

Los cinco checkpoints actuales pasan sus esquemas y el `runCriticPrechecks` actual pasa sin issues. Su cobertura incidente concreta es:

- **TechCrunch → WSJ:** `sourceEvidence[0].contentExcerpt` conserva “The Wall Street Journal reports…”, “the Journal writes” y el nombre TechCrunch en el contexto del extracto. La fuente es TechCrunch AI, con URL, `sourceId`, `sourceItemId` y `contentHash` enlazados.
- **Reporte e incertidumbre:** `verification.status = single_source`, `confidenceScore = 60` y `verification.uncertainClaims[0]` conservan los matices sobre las pruebas. El extracto atribuye los hallazgos al WSJ y registra que TechCrunch pidió comentarios. El evento tiene `sourceCount = 1`.
- **Envelope aprobado:** `verification.verifiedFacts` contiene las dos proposiciones aprobadas, cada una ligada al source ID. La incertidumbre queda separada; no se promovió al envelope como hecho verificado.
- **Claims y detalle no sustentado:** `editorial.bodyEs`, titular, dek, resumen, `whyItMattersEs` y `keyPoints` permanecen disponibles para comparar. El riesgo de “internal evaluation standards” y deliberaciones no aparece respaldado por el extracto.
- **Geografía/entidades:** región `US`, país `US`, compañías `OpenAI`, modelo `Astra 6.1`, coordenadas `39.8283,-98.5795`, resolución de registro `region_registry`.

Esto prueba cobertura del input existente, no de la proyección compacta propuesta. Al no cambiar el builder, no se afirma que una nueva representación haya pasado los bad-draft o positive controls. La suite Critic existente sigue pasando y verifica escalada de certeza, detalle interno no sustentado, pérdida de atribución, reporte directo, reporte secundario atribuido y control The Verge.

## PROMPT VERSIONING

Antes y después de esta fase: `critic-v3`. No se cambió prompt ni input serializer. `critic-v3` ya contiene las reglas factuales introducidas para este incidente y sigue siendo interpretable históricamente. Una futura proyección que conserve estructura/semántica y solo quite repeticiones podría mantener v3 si conserva las instrucciones sin cambios semánticos. Si cambia cómo se expresan o evalúan atribución, incertidumbre o referencias, debe publicarse como nueva versión (`critic-v4`), no sobrescribir v3.

Los logs de agentes registran la versión efectiva por etapa; los checkpoints no tienen un campo de versión. La propiedad por stage log permitiría identificar una futura versión de Critic, pero no resuelve el bloqueo de reanudación de la fila de intento finalizada.

## SAME-ATTEMPT RESUME

Clasificación exacta: **`SAME_ATTEMPT_RESUME_NOT_SUPPORTED`**.

Los cinco checkpoints presentes pertenecen al directorio de run `db368f10-d9c1-4897-b752-b3d2cb156e09`, su event key coincide en todos los stages y sus parsers Zod pasan. El checkpoint Ranker liga el mismo source/item ID y hash de extracción esperado. Sus SHA-256 permanecieron estables:

| Stage | SHA-256 |
| --- | --- |
| Verifier | `668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378` |
| Translator | `668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378` |
| Editor | `ac88461328385917a3c9ebd219815b06211b1d0ed64684eea1f0993c4e5cc218` |
| Classifier | `947951b78f3aa39719943d8d916a70c23a796777b33557b8dcb5d67d3b4a345d` |
| Ranker | `17d758b3883239ab7e3dc28141b8449c9b93df43827f56d77b4ef6fe506d5edf` |

Los checkpoints no incluyen el attempt ID internamente; la relación con `a82482be-58d8-4fc6-ac16-946d0906257b` procede del resultado/auditoría del run y de sus rutas con run ID. No se usaron como ejecución reanudada. No se repitieron llamadas ni se alteraron hashes.

Para reanudar correctamente el mismo intento hacen falta dos piezas: rehidratar Verifier→Ranker desde checkpoints validados e introducir una transición de ciclo de vida atómica para reanudar la fila terminal existente en Critic, preservando su fallo previo en el historial. La segunda pieza requiere soporte de esquema/RPC. Migration 28 está prohibida aquí; el trabajo se detuvo.

## TPM DECISION

Estado de este run: `REQUEST_TOO_LARGE_FOR_TPM`; Critic no fue reservado ni despachado. No existe un nuevo total estimado ni headroom después de compactar, porque el compactador no se implementó. El guard actual conserva 128 tokens de margen, con máximo estimado 7.872 frente al límite hard 8.000. Las cabeceras de reset solo determinan cuándo despachar una solicitud que ya cabe; esperar no corrige los 9.005 del plan existente.

La futura ruta mantiene Groq only, una llamada Critic como máximo, cero reintentos/fallback; un resultado distinto de pass detiene el flujo. Publisher solo puede ejecutarse determinísticamente tras un Critic pass y con un mecanismo de reanudación permitido. No se ejecutó esa ruta.

## REGRESSIONS

- Checkpoints, prechecks, geo e identidad del input incidente: PASS offline.
- Suite existente `critic:unit`: PASS; cubre bad cases y controles positivos solicitados con el builder actual.
- 55 suites offline del repositorio: PASS.
- `npm run lint`: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS.
- Llamadas a proveedores en esta fase: 0. Escrituras remotas: 0. Intentos nuevos: 0. Mutaciones/publicación: 0. Migraciones: 0.

La regresión específica “bad drafts y positive controls a través del nuevo builder compacto” queda **NO EJECUTADA** porque no existe un nuevo builder: la instrucción de stop impide implementar una ruta de reanudación que no puede cerrar el ciclo de vida del intento.

## REAL STATE

- Última evidencia exitosa: artículo archivado; ausente de `public_published_articles`; dos artículos públicos; piloto 5/5 intentos y 24/30 llamadas; Critic no despachado; migration 27 aplicada y 28 ausente.
- Lectura remota intentada en esta fase: `PGRST303`; no produjo una confirmación en vivo. Sin escrituras remotas.
- El artefacto de 12C.2B.2 registra Critic no despachado, sin checkpoint, Publisher no ejecutado, artículo archivado y sin fila pública para el slug.
- Cambios de esta fase: solo este informe y `artifacts/critic-tpm-fit-remediation-12c2b2a.json`.

## NEXT STEP

**Detenerse.** No ejecutar una reanudación ni intentar otro claim. La reanudación del intento existente necesita una transición de ciclo de vida/RPC de base de datos que la fase actual prohíbe. Critic sigue sin caber en 8.000 TPM con el serializador actual y no se calculó un reemplazo. No pasar automáticamente a 12C.2B.2b.
