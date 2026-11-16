# Factual remediation execution — 12C.2B.2

**Resultado: STOPPED SAFE, NO PUBLICADO.** El último intento del piloto quedó consumido (5/5) y el artículo sigue archivado. La ejecución se detuvo antes de enviar la sexta solicitud prevista: el guard de TPM rechazó la entrada de Critic por exceder el límite de etapa.

## PREFLIGHT

- Fecha de revisión: 2026-10-02 UTC. Migración 26 aplicada; 27 aplicada y más reciente; 28 ausente.
- El artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3`, evento `5138e509-f4c3-4020-9d13-6a6efac99a39` / `event-30f226d1b8ba5c9eb8af2b65c46db512`, slug `openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad`, estaba archivado y fuera del contrato público. Había dos artículos públicos.
- El único intento previo del incidente (`4017edf4-86be-49f1-a464-e766ad371284`) seguía en `READY_FOR_PUBLICATION`; había cero intentos reales de remediación. El contador del piloto era 4/5.
- El ledger histórico de los cuatro intentos del piloto confirmó 19 solicitudes Groq: 6 + 1 + 6 + 6. Quedaban 11 del presupuesto de 30 antes de esta ejecución.
- Se validó y reutilizó solo la extracción guardada de TechCrunch AI: raw item `d3834944-72f6-4f59-9aca-3f66ae92dc33`, 1.756 caracteres, hash SHA-256 `4ce8abf4e1b0374453cda72073dbbf920586e61e4b650bcc674788368f249e1e`. No se volvió a descargar la fuente.
- El snapshot de los dos artículos públicos se capturó antes de la reclamación y coincide después. Los checkpoints y el intento históricos también siguen preservados.
- Se ejecutaron 55 suites offline antes de la llamada y las 55 volvieron a pasar después. La configuración resolvió los seis modelos a `openai/gpt-oss-20b`, router apagado, cero reintentos, fallback de pago desactivado, fallo cerrado ante rate limit y concurrencia 1.
- La primera invocación mediante `npm run` devolvió `mode: preflight`, con cero llamadas y cero escrituras porque no trasladó los argumentos. No creó un intento. La única ejecución real usó el runner canónico directamente con `--execute-factual-remediation`.

## CAPACITY

- Ledger Groq del 2026-10-02 antes de reclamar: 0 solicitudes, 0 tokens y 0 reservas desconocidas; sin bloqueo temporal. Límites configurados: 1.000 RPD / umbral blando 850; 200.000 TPD / umbral blando 170.000; 30 RPM; 8.000 TPM.
- La política actual planificó seis solicitudes y 12.934 tokens (observación N=1 de 10.347 con margen del 25%). La admisión completa pasó: 6 < 850 y 12.934 < 170.000. El `quotaRemaining: 849` del CLI representa el presupuesto de admisión hasta el umbral blando menos uno, no las solicitudes duras libres.
- La última cabecera TPM guardada del evento antes de comenzar era del 29 de septiembre (5.464/8.000 tokens restantes, reset informado 19,02 s), por lo que se registró como obsoleta. El runtime aplicó su pacing canónico y recibió cabeceras nuevas tras cada respuesta correcta. La última respuesta Groq, Ranker, reportó 5.704/8.000 tokens TPM y 995/1.000 solicitudes diarias restantes.
- Resultado del ledger del día tras el cierre: 5 reservas y 5 despachos Groq, 7.366 tokens liquidados (6.058 entrada + 1.308 salida), 0 desconocidos, 0 bloqueos y 0 respuestas 429. Cloudflare: 0; Cerebras: 0.

## REMEDIATION CLAIM

- Reclamación atómica única: intento local 2, piloto 5/5, propósito `FACTUAL_REMEDIATION`, inicio `VERIFIER`, intento `a82482be-58d8-4fc6-ac16-946d0906257b`, run `db368f10-d9c1-4897-b752-b3d2cb156e09`.
- Autorización registrada: Diego; referencia `105932dd-1d8a-4f9d-ab0d-b7809a68604f`, solicitud 12C.2B.2. El intento terminó `TECHNICAL_FAILURE` en Critic con `cost_guard_violation`, `retryClass: NONE`, sin contabilizar como reintento.
- No hubo retry, fallback, edición manual, modificación de checkpoints antiguos ni publicación. El contador final del piloto es 24/30 llamadas y 5/5 intentos.

## CHECKPOINT BOUNDARY

- Se inició en Verifier con linaje determinista almacenado. No se leyeron checkpoints downstream anteriores como resultados de remediación.
- Los seis checkpoints históricos del run `63b81d9a-e46f-4434-9637-335d3f455e0b` conservaron sus hashes; el snapshot 12C.1 también coincide (`73246b8473749e904c5de12f4765b3f2e8da489f26584a22938b40decaad43cd`).
- El run nuevo creó cinco checkpoints validados (Verifier, Translator, Editor, Classifier y Ranker). Critic no produjo checkpoint porque el guard bloqueó antes de despachar; Publisher no se alcanzó. Sus hashes están en el artefacto JSON.

## VERIFIER

- PASS: una llamada Groq, HTTP 200, Zod válido, cero retries; verificación marcada `single_source`, confianza 60, 2.081 tokens liquidados.

## TRANSLATOR

- PASS: una llamada Groq, HTTP 200, Zod válido, cero retries; salida aceptada por el pipeline, 1.364 tokens liquidados.

## EDITOR

- PASS: una llamada Groq, HTTP 200, Zod válido, cero retries; `validateEditorialDraftOutput` aceptó la salida. Pasaron el esquema, linaje de evento, control de URL de fuente, nombres preservados, procedencia de cifras/fechas y límite de reproducción de la fuente. Se liquidaron 1.653 tokens.

## FACTUAL GUARDS

- Las 55 suites offline anteriores y posteriores pasaron. Incluyen los contratos de Verifier, Translator, Editor, Critic, pipeline, Publisher y remediación.
- Classifier pasó con una llamada (1.143 tokens); Geo resolvió determinísticamente `primaryRegionCode=US` contra el registro activo; Ranker pasó con una llamada (1.125 tokens), fórmula `ranking-v1`.
- Critic construyó la entrada y pasó sus prechecks deterministas de identidad, cobertura de evidencia y geografía. Antes de reservar o enviar la solicitud, el guard TPM estimó 9.005 tokens frente al límite duro de 8.000 (más margen de seguridad de 128) y bloqueó. No existe decisión Critic ni resultado de Publisher.
- La revisión pública de afirmaciones, atribución/certidumbre, cadena TechCrunch → WSJ y `Por qué importa` queda sin ejecutar porque no se publicó un artículo corregido. No se afirma que esos criterios hayan recibido aprobación editorial pública.

## PRODUCT QA

- `npm run build`: PASS. La app de producción local devolvió home 200 con los dos slugs públicos existentes y sin el slug del incidente; ambas rutas `/noticias/{slug}` existentes devolvieron 200 con encabezado y marcado de artículo; la ruta del incidente devolvió 404.
- El artículo continúa archivado, el conteo público continúa en 2 y los dos hashes coinciden con el snapshot previo. La revisión pública del contenido corregido y su mapa/categoría no aplica; no hubo publicación. `activity_history` sigue siendo trabajo de agregación posterior.

## FINAL ACCOUNTING

| Etapa | Solicitudes Groq | Tokens liquidados | Resultado |
|---|---:|---:|---|
| Verifier | 1 | 2.081 | PASS |
| Translator | 1 | 1.364 | PASS |
| Editor | 1 | 1.653 | PASS |
| Classifier | 1 | 1.143 | PASS |
| Geo | 0 | 0 | PASS determinista |
| Ranker | 1 | 1.125 | PASS |
| Critic | 0 | 0 | Bloqueado pre-dispatch: 9.005 > 8.000 TPM |
| Publisher | 0 | 0 | No alcanzado |

- Total nuevo: 5 solicitudes, 7.366 tokens; todas las reservas despachadas se liquidaron con uso conocido. Piloto: 24/30 llamadas, 5/5 intentos. 429: 0. Proveedores alternativos: 0.
- Verificación posterior: 55/55 suites offline, ESLint, TypeScript, build y `git diff --check` pasan.

**12C.2B.2 READY: NO.** Parar aquí. El piloto agotó su quinto intento. No crear intento 6 ni pasar automáticamente a 12D. La siguiente decisión requiere revisar el tamaño del contexto/estimación de Critic que excedió el TPM; no se modificó ni el límite ni el guard.
