# 12F — First Real Supervised Cycle

**Resultado:** `12F READY = YES`\
**Stop classification:** `CANDIDATE_SAFELY_REJECTED`\
**Candidato real admitido:** 1 de un máximo de 1\
**Acción humana:** ninguna

La ejecución observó un candidato real y terminó en Verifier con rechazo por evidencia insuficiente. Es uno de los finales seguros permitidos para 12F; no es un fallo del runtime. El camino ideal hasta `WAITING_FOR_HUMAN_REVIEW` no se alcanzó, por lo que no existe paquete que revisar en 12F. No se procesó un reemplazo.

## BASELINE

- Entrada: 12E.2 `READY`; migration 31 aplicada y migration 32 ausente. No se aplicaron ni crearon migraciones durante 12F; Astra no se tocó.
- Configuración: modo `SUPERVISED`; límite configurado de 3 candidatos/día y 2 publicaciones/día; concurrencia 1; ejecución limitada a 1 candidato; reintentos 0; fallback, Publisher y remediación factual automática desactivados. El scheduler recurrente permaneció apagado.
- Estado remoto antes de admitir: 0 intentos y 0 candidatos del día, 0 reviews esperando, 0 trabajo activo/atascado; 2 artículos públicos; Astra archivada. El ledger Groq del día estaba en 0 solicitudes, 0 tokens, 0 reservas de uso desconocido y sin bloqueo temporal.
- Artículos públicos al inicio (IDs y hashes MD5 recogidos en la lectura de baseline):
  - `6203559f-413a-4f06-9346-1720bbeb0e7a` — `openai-emplea-agentes-para-escanear-el-sitio-de-estadisticas-de-la-onu-mas-de-16-000-veces` — `ccef966880d85663b8fd5049e9995f5f`.
  - `7415c685-04ed-4956-a77a-4bc372c9b060` — `mas-de-mil-fallecidos-tras-fallas-en-torres-de-vigilancia-fronteriza` — `4cf1ecf2990a5dca582c95e5733a484f`.
- La comprobación inicial de capacidad admitió un evento con el presupuesto conservador vigente. No se reutilizó el presupuesto histórico 28/30 del piloto 12A–12C.
- Se conservaron los cambios no relacionados ya presentes en el árbol de trabajo. No se hizo commit.

## DISCOVERY

Se ejecutó Discovery con la configuración actual de fuentes y las reglas deterministas de admisión. Se seleccionó un solo candidato legítimo y actual. No se seleccionó Astra ni un incidente histórico. El contenido externo se trató como datos no confiables.

La primera invocación mediante `npm run pipeline:supervised:run -- --execute-supervised` terminó en el validador de argumentos, antes de conectarse a Supabase o llamar a un proveedor. La invocación explícita del script con `--execute-supervised` ejecutó después la única corrida autorizada; no produjo un segundo candidato.

## CANDIDATE

- Título: **2026 Climate Tech Companies to Watch**.
- Fuente: MIT Technology Review; URL `https://www.technologyreview.com/2026/10/06/1143800/2026-climate-tech-companies-to-watch`.
- Fecha de publicación detectada: `2026-10-06T10:35:00Z`.
- `sourceId`: `e3a5ef5a-c4d8-42bf-bc3c-08284952d3e4`.
- `candidateId`: `e3a5ef5a-c4d8-42bf-bc3c-08284952d3e4:ad0ddc99994ef7d45021c8321152105d`.

## EVENT / ATTEMPT

- Identidad de pipeline: `event-ee5412887603e4914658137010f51d08`.
- Run: `45ee9e60-92a4-4b11-a736-bb2f005b50d8`.
- Intento: `1cf75dc8-cd03-4aa2-b2db-b847286d9745`, `attempt_number=1`.
- Solo hay una fila de intento para este `pipeline_run_id`; no hubo intento duplicado.
- No se materializó una fila `events` ni un `eventId`: el pipeline paró en Verifier antes de crear un evento persistente/publicable. Se conserva el `eventKey` como identidad de esta ejecución.
- Estado final: `VERIFICATION_INSUFFICIENT`; `stop_stage=verifier`; `stop_reason=SKIPPED_VERIFICATION_INSUFFICIENT`; no cuenta para reintento.

## EXTRACTION

La fuente quedó enlazada a un único `raw_item` extraído:

- `rawItemId`: `bf446840-8bf9-44d0-8ad0-8315bc174d45`.
- Fuente, URL canónica y original: MIT Technology Review y la URL indicada arriba.
- Título del raw item: `2026 Climate Tech Companies to Watch`.
- Hash del contenido extraído: `sha256:a18068e7055ce08ea4fd650f0d1725c946a0c5d2873192aecfe06238d127818d`.
- Estado: `extracted`.

## CLUSTERING

Clustering formó la identidad de evento del pipeline con una fuente, título canónico `2026 Climate Tech Companies to Watch` y confianza 45. No encontró un artículo público duplicado para publicar. Al ser rechazado antes de persistir el evento, no hay fila `events` ni relación persistida en `event_sources`.

## VERIFIER

Se ejecutó exactamente una vez con Groq, salida estructurada válida. Resultado `rejected`, confianza 10, sin fuente primaria, fuentes de apoyo ni hechos verificados. Razón registrada: “No verifiable evidence of the claimed event in the supplied source.” La política detuvo este candidato sin reemplazo.

## TRANSLATOR

`NOT_RUN` — Verifier rechazó el candidato.

## EDITOR

`NOT_RUN` — Verifier rechazó el candidato.

## CLASSIFIER

`NOT_RUN` — Verifier rechazó el candidato.

## RANKER

`NOT_RUN` — Verifier rechazó el candidato.

## CRITIC

`NOT_RUN` — el candidato no pasó Verifier. No hubo dispatch a Critic y no se declara un resultado de Critic.

## ACCOUNTING

- Groq: 1 solicitud, reservada y liquidada; modelo `openai/gpt-oss-20b`.
- Verifier: 1 llamada; entrada 1302 tokens, salida 177, total 1479.
- Etapas Translator, Editor, Classifier, Ranker y Critic: 0 llamadas / 0 tokens.
- Uso diario tras la corrida: 1 solicitud, 1479 tokens; solicitudes con uso desconocido 0; bloqueo temporal 0; 429: 0.
- Reintentos: 0. Fallback: 0. Cloudflare: 0. Cerebras: 0. Publisher: 0. Llamadas de proveedores de IA después de terminar el pipeline: 0.
- La telemetría confirma HTTP 200, `providerRequestDispatched=true`, liquidación completa, 1302/177/1479 tokens y `retries=0`.

## HUMAN REVIEW TRANSITION

`NOT_REACHED_VERIFIER_REJECT`. No se llamó a la RPC de creación de review; `reviewId=null`; no se produjo review manifest ni hash. No se ejecutó aprobación, HOLD, REJECT ni publicación.

## OPERATOR STATUS

`PASS` — lectura de estado posterior a la corrida: 1 candidato y 1 intento hoy; 0 esperando review, 0 HOLD, 0 rechazados por decisión humana, 0 publicados, 0 fallidos, 1 solicitud Groq / 1479 tokens, 0 uso desconocido, 0 trabajo activo y 0 atascado.

## OPERATOR INSPECT

`NOT_RUN` — no hay review ID porque el candidato no llegó al estado de espera humana. `list` e `inspect` no se usaron para un paquete inexistente.

## PUBLIC CONTRACT

- Lectura posterior: 2 artículos con estado `published`, los mismos IDs y slugs del baseline; ambos artículos públicos devolvieron HTTP 200.
- No se materializó artículo para este candidato; el total público siguió en 2 y el candidato no aparece en portada ni en el mapa.
- Astra sigue `archived`; su ruta devolvió HTTP 404.
- Los hashes de baseline se preservan en el artefacto. La lectura posterior confirmó conteo, IDs, slugs, estado y contenido servido. El hash de fila PostgreSQL no se recalculó en esta lectura; no se ejecutó Publisher ni una ruta que escriba artículos.

## QA

- Suites package offline de unidad/simulación: **61/61 PASS**. Se añadieron las fixtures locales de migration 29 y 30; migration 31 está incluida en las 61 suites. Total de invocaciones locales: 63/63 PASS.
- Migration 29: PASS. Migration 30: PASS. Migration 31: PASS.
- `npm run lint`: PASS.
- `npx tsc --noEmit --pretty false`: PASS.
- `npm run build`: PASS (Next.js 16.3.4).
- `git diff --check`: PASS; solo informó avisos de conversión LF/CRLF del árbol de trabajo Windows.
- Smoke de build local: home 200 con las dos historias existentes; rutas de ambos artículos 200; `/fuentes` 200; `/metodologia` 200; Astra 404. El mapa cargó tiles, atribución, una ubicación, dos historias y controles; el control de zoom fue accionado.
- La espera de review no fue necesaria para esta salida segura. No se inspeccionó un paquete inexistente.

## FINAL STATE

`CANDIDATE_SAFELY_REJECTED`. El runtime ejecutó la admisión y una llamada Verifier bajo los límites y se detuvo al recibir un rechazo factual. No es `SUPERVISED_RUNTIME_FAILURE`. El objetivo ideal `Critic PASS → WAITING_FOR_HUMAN_REVIEW` quedó sin alcanzar.

## HUMAN DECISION REQUIRED

No hay paquete que someter a decisión humana en esta corrida. No tomar una decisión sobre este candidato ni iniciar una nueva corrida como parte de 12F. La siguiente fase de revisión humana solo tendrá un objeto cuando una ejecución supervisada futura llegue a `WAITING_FOR_HUMAN_REVIEW` y produzca su paquete durable.
