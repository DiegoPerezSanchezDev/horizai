# 12F.1b — Generic pre-provider discovery quality gate

**12F.1b READY = YES.** Evidencia y regresiones offline del 7 de octubre de 2026. Provider calls=0; real pipeline execution=0. 12F.2 no se inició.

## WHY HASH FILTER WAS REMOVED

El filtro de 12F.1 dependía de www.technologyreview.com y sha256:a18068e7055ce08ea4fd650f0d1725c946a0c5d2873192aecfe06238d127818d. Estaba en lib/agents/extraction/non-editorial-content.ts, función isKnownNonEditorialExtraction; create-production-pipeline.stages.clustering lo invocaba antes de formar/seleccionar eventos. Sus pruebas comprobaban texto exacto/hostname y cuerpos alterados. Se eliminó el módulo y su llamada de producción. El caso permanece únicamente como evidencia/fixture. No hay reglas de hash, hostname, fuente, título concreto ni texto específico en el gate.

El filtro anterior podía eliminar silenciosamente el candidato antes de slice(limit). El nuevo gate actúa sobre el candidato ya seleccionado y claimed, con resultado terminal registrado, por lo que un rechazo no abre un hueco para un reemplazo en esa corrida.

## AVAILABLE EVIDENCE

Se usaron fixtures existentes y seis raw_items ya persistidos, leídos sin mutación y copiados a scripts/fixtures/stored-discovery-evidence-12f1b.json. event_sources confirmó el enlace de los dos raw items con los dos artículos públicos. También se usan fixtures de contracts, Readability/extraction y secondary attribution. No se consultó contenido web nuevo.

El HTML original de 12F no fue retenido. No se demuestra que Extraction perdiera un cuerpo editorial disponible ni que hubiera una limitación técnica de acceso. La clasificación soportada permanece **DISCOVERY_QUALITY_FILTER_GAP**. El rechazo de Verifier fue apropiado para el input completo recibido.

## QUALITY CORPUS

20 casos: 10 buenos esperados, 9 insuficientes esperados, 1 histórico diagnóstico sin etiqueta impuesta. Las variantes de edge cases derivan de texto/fixtures guardados. El archivo scripts/discovery-evidence-quality-fixtures.mjs conserva procedencia y etiquetas; el artefacto JSON registra señales de todos los casos. Los hashes de los snapshots se usan solo para reproducibilidad, nunca para decidir admisión.

| Caso | Caracteres | Frases con prosa | Frases relacionadas | Gate | Etiqueta |
| --- | ---: | ---: | ---: | --- | --- |
| public-un-agents | 1640 | 12 | 7 | ELIGIBLE | Good |
| public-border-towers | 992 | 6 | 3 | ELIGIBLE | Good |
| historical-meta-muse | 7908 | 49 | 19 | ELIGIBLE | Good |
| historical-engram | 1954 | 16 | 8 | ELIGIBLE | Good |
| historical-microrobot-references | 9948 | 48 | 19 | ELIGIBLE | Diagnostic |
| mit-703 | 703 | 3 | 0 | REJECT | Insufficient |
| contract-article | 152 | 2 | 1 | ELIGIBLE | Good |
| short-article | 87 | 1 | 1 | ELIGIBLE | Good |
| short-no-final-punctuation | 86 | 1 | 1 | ELIGIBLE | Good |
| html-extraction | 343 | 4 | 1 | ELIGIBLE | Good |
| spanish-extraction | 225 | 2 | 1 | ELIGIBLE | Good |
| secondary-attribution | 146 | 2 | 2 | ELIGIBLE | Good |
| metadata-teaser | 129 | 1 | 1 | REJECT | Insufficient |
| title-related-teaser | 38 | 0 | 0 | REJECT | Insufficient |
| long-promotion | 5638 | 24 | 0 | REJECT | Insufficient |
| changed-corporate-block | 724 | 3 | 0 | REJECT | Insufficient |
| long-navigation | 1618 | 0 | 0 | REJECT | Insufficient |
| headline-echo | 948 | 0 | 0 | REJECT | Insufficient |
| empty | 0 | 0 | 0 | REJECT | Insufficient |
| noise | 17 | 0 | 0 | REJECT | Insufficient |

## SIGNALS

Se miden longitud, palabras, párrafos, frases con prosa, frases relacionadas, cobertura de términos del candidato, diversidad léxica, frases únicas y metadata_only. Solo tres predicados determinan la decisión. La longitud es diagnóstico y no constituye admisión por sí sola. Diversidad/repetición se registra para examinar el corpus; no se añadió un score ponderado ni un detector de publicidad.

Se reutilizan normalizeEventText/eventTokens: normalización NFKD, eliminación de acentos, minúsculas y stopwords/ruido editorial generales ya existentes. Los números aislados no crean relación con el titular. Intl.Segmenter separa palabras/frases; los saltos de línea guardados delimitan párrafos. Se descartan segmentos que solo repiten el titular. Se combinan título canónico del candidato y título del item para conservar el vínculo con cada fuente. No se invoca la clasificación de entidades/fuentes del módulo de clustering.

“Frase con prosa” significa al menos 8 palabras y 3 términos distintos adicionales a los del titular. No equivale a “hecho verdadero” ni a una prueba de credibilidad. La frase corta de contrato tiene 10 palabras/87 caracteres y permanece elegible; también pasa sin punto final. No se exige número, fecha, verbo factual de una lista cerrada ni cierta cantidad de párrafos.

## GENERIC GATE

Implementación: lib/agents/extraction/evidence-quality.ts, assessExtractionEvidence y assessCandidateEvidence.

1. Cuerpo extraído no vacío y distinto del fallback metadata_only, que según el contrato de extracción aporta solo el discovery excerpt.
2. Al menos una frase con prosa: >=8 palabras y >=3 términos distintos más allá del titular. Evita encabezados, labels de navegación y repetición de títulos.
3. Al menos una de esas frases comparte >=1 término significativo con el título canónico/de la fuente. Evita gastar un Verifier en un cuerpo claramente ajeno al candidato.

Para un candidato con varias fuentes basta que una aporte esa evidencia mínima; Verifier sigue evaluando fuentes, atribución, contradicciones y hechos. El gate permite prosa plausible con atribución incierta. No usa hash, URL, hostname, IDs, nombre de fuente o un blacklist de palabras corporativas.

## MIT REPLAY

Texto exacto: 703 caracteres, 97 palabras, 4 segmentos, 2 párrafos con prosa y 3 frases con prosa. Términos del candidato: climate / tech / companies; frases relacionadas=0, cobertura=0. Resultado: **REJECT_PRE_PROVIDER / NO_CANDIDATE_RELATION**, terminal EXTRACTION_EVIDENCE_INSUFFICIENT.

El texto contiene biografía institucional/publicidad y no información sobre las empresas del título. Una variante de 724 caracteres cambia institución/año y hash; también se rechaza por la misma ausencia de relación. Cambiar solo hostname, metadata de fuente o hash deja todas las señales idénticas. Verifier dispatch=0; todos los demás stages/review/Publisher=0 en replay sintético.

## GOOD-CASE REGRESSION

Los dos snapshots vinculados a artículos públicos pasan: ONU/OpenAI 1640 caracteres, 7 frases relacionadas; torres fronterizas 992 caracteres, 3 frases relacionadas. Se reevalúa su texto pre-Verifier guardado, sin llamar al modelo. También pasan Meta/Muse, Engram, el contrato de extracción, la frase corta, su variante sin punto final, dos extracciones HTML existentes y la atribución secundaria incierta: **10/10 buenos elegibles**.

La bibliografía de microrobots contiene texto y términos relacionados y queda ELIGIBLE como caso incierto; no se afirma que soporte la noticia. Verifier decidiría si aporta evidencia factual suficiente. La navegación de labels derivados de ese snapshot, sin prosa, sí se rechaza.

## FALSE-POSITIVE RISK

En el corpus etiquetado: **0/10 falsos positivos y 0/9 falsos negativos**. No es una estimación de recall de producción: la muestra es pequeña.

La primera matriz detectó una fixture técnica que titulaba la segunda fuente “Second event” y copiaba un cuerpo de producción de aceleradores. No había término compartido con sus títulos; el gate se adelantó al fallo Translator que esa prueba pretendía provocar. Se alinearon discovery/title/sourceItem a “Second AI chip enters production”, conservando las assertions originales de fallo técnico downstream.

Ese caso expone un riesgo real fuera del corpus: paráfrasis como chip/accelerator, títulos vagos, cuerpos muy breves y traducciones sin términos compartidos pueden quedar rechazados. No se añadieron diccionarios de sinónimos ni reglas por fuente para ocultarlo. Un metadata_only puede ser informativo, pero el contrato del gate exige un cuerpo extraído. En sentido contrario, referencias o promoción con prosa relacionada pueden quedar elegibles; el gate conserva la responsabilidad factual de Verifier.

## TERMINAL BEHAVIOR

PipelineOrchestrator.runEvent evalúa el gate después de selección/claim y antes de runEventStages: aplica a admisiones normales standard/supervised. Las entradas de continuación/remediación no se modificaron.

CandidateEvidenceAssessment es una unión discriminada tipada. Insuficiencia → pipeline SKIPPED, stopStage=extraction, stopReason=EXTRACTION_EVIDENCE_INSUFFICIENT, evidenceQuality con razones/señales. El mapeo de attempt usa el estado ya existente **REJECTED**, retryClass=REJECTED, countsTowardRetryLimit=false, nextEligibleAt=null; evaluateNormalEligibility lo trata como PERMANENT_OUTCOME. No se presenta como failure técnico/proveedor y no requiere migración.

Fixtures en standard/supervised con dos candidatos y limit=1 prueban un único intento finalizado, Verifier/Translator/Editor/Classifier/Ranker/Critic/Publisher=0, review=0, reservas=0, retries=0 y replacement=NO. La regresión de rechazo real de Verifier se conserva con un output mock: solo Verifier es invocado, sin downstream/review/reemplazo.

## CANONICAL COMMAND

Comando operativo Windows:

```powershell
npm.cmd run pipeline:supervised:run -- --execute-supervised
```

Se conserva npm.cmd. Prueba de argumentos con entrypoint parser-only aislado y --help del entrypoint real PASS. No se ejecutó el comando real con --execute-supervised; no se adquirió lease ni se activó scheduler.

## PUBLIC HASH EVIDENCE

Método histórico recuperado, ejecutado de nuevo dentro de BEGIN READ ONLY:

```sql
md5(concat_ws(chr(31), a.slug, a.headline_es, coalesce(a.summary_es,''), coalesce(a.why_it_matters_es,''), coalesce(a.body_es,''), a.metadata::text))
```

Algoritmo MD5 de PostgreSQL. Orden de campos: slug, headline_es, summary_es, why_it_matters_es, body_es, metadata. Separador ASCII31. summary/why_it_matters/body NULL → ''. Sin trim/case/Unicode/whitespace normalization. metadata conserva exactamente la serialización PostgreSQL jsonb::text; concat_ws omite argumentos NULL. El agregado de artículos se ordena por a.id. No se sustituyó por un fingerprint de body/JSON REST.

| Artículo | Baseline 12F / actual |
| --- | --- |
| 6203559f-413a-4f06-9346-1720bbeb0e7a | ccef966880d85663b8fd5049e9995f5f |
| 7415c685-04ed-4956-a77a-4bc372c9b060 | 4cf1ecf2990a5dca582c95e5733a484f |

**COMPARABLE + UNCHANGED**, conteo público 2, Astra archived. Lecturas 2026-10-07T18:36:56.867464+00:00 y 2026-10-07T18:49:35.276457+00:00: 135 reservas/38695 tokens globales y ledger hash 5a6d82ab6ca91dfc038796a694b989ef, sin cambios. Delta requests=0/tokens=0. Intentos (9/hash), reviews (0/hash) y scheduler hash también permanecen idénticos. No hubo mutaciones reales ni migraciones.

## TESTS

63/63 suites package de unidad/simulación; migration29 y30 standalone; migration31 incluida; publisher failure analysis y contracts adicionales: **67/67 suites offline finales PASS**. Corpus 20 casos/19 etiquetados PASS + 1 diagnóstico. La primera matriz detectó la fixture técnica descrita; la matriz completa se repitió después del ajuste y pasó. Las nuevas assertions de invarianza y unión tipada se volvieron a verificar.

lint PASS; npx tsc --noEmit --pretty false PASS; npm run build PASS (Next16.3.4); git diff --check PASS. Todos los providers/scheduler/reviews/Publisher de tests son mocks/fixtures offline. Groq/Cloudflare/Cerebras/inference=0. Revisión visual no aplicable: no hubo cambios de UI.

## READINESS

OBSERVE: regla por hash y snapshots existentes. PLAN: sustituirla por mínimos genéricos, conservar casos buenos y un desenlace terminal. EXECUTE: gate, integración al intento seleccionado, mapping REJECTED y corpus. CRITIQUE: documentar incertidumbre de referencias y paráfrasis sin añadir excepciones específicas. VERIFY: regresiones, build y baselines comparables.

**12F.1b READY = YES.** Filtro específico eliminado, gate genérico implementado, MIT rechazado antes del proveedor, buenos preservados, terminal tipado sin replacement, hashes comparables sin cambios, comando Windows validado y provider delta=0. La clasificación histórica permanece DISCOVERY_QUALITY_FILTER_GAP.

Siguiente fase: 12F.2 — SECOND REAL SUPERVISED CYCLE, exactamente un candidato máximo. Antes de una ejecución futura: public hashes, accounting baseline y candidate eligibility evidence. Objetivo: Critic PASS → WAITING_FOR_HUMAN_REVIEW. **12F.2 no se inició. DETENERSE.**
