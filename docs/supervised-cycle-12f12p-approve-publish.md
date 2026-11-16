# FASE 12F.12P — aprobación humana y publicación supervisada

## Resultado

La revisión humana autorizada fue aprobada para la revisión corregida vinculada y publicada una sola vez. El artículo público corresponde a la revisión `6fd9fae7-dbc6-4e13-abba-c4c6dfca38d9` (SHA-256 `69f0d3e350621f86c69a72d2cb1cbf1cb390212d695f932eedb03d325ade2045`), con el titular **«CERT-In informa de accesos de agentes de IA durante evaluaciones en India»**. La aprobación y la publicación se reconciliaron por las rutas canónicas; el artículo, el evento y el paquete revisado coinciden.

## Alcance ejecutado

- Revisión: `ebd8acc0-76a2-4977-81d9-60a7f6240084`.
- Revisión humana: `6fd9fae7-dbc6-4e13-abba-c4c6dfca38d9`; SHA-256 corregido: `69f0d3e350621f86c69a72d2cb1cbf1cb390212d695f932eedb03d325ade2045`.
- Paquete: SHA-256 `e0afb3491736859512f65916804ce26153a92811b673bbfc5650dfdbf4c340e7`.
- Decisión humana: `APPROVE`, por Diego, con comprobaciones factual, atribución, incertidumbre, titular, resumen, afirmaciones no respaldadas y cadena de fuentes aprobadas.
- Despachos RPC de aprobación: 1. La validación local inicial del CLI no llegó a despachar RPC; se corrigió el formato de invocación y se verificó el estado pendiente justo antes del único despacho válido.
- Invocaciones de Publisher: 1; resultado `PUBLISHED`; artículo `64ac852b-2d67-4048-953c-9c9e8c5e2ef2`.
- Reintentos: 0. Generación de proveedores en esta fase: 0 llamadas. Contabilidad acumulada del paquete: 6 solicitudes, 10.792 tokens.

## Reconciliación y verificación

Antes de aprobar, el paquete, los checkpoints y la revisión objetivo pasaron las comprobaciones; el destino era la revisión humana exacta, sin consumo ni publicación previos. Después de aprobar, la lectura canónica mostró `APPROVED`, la acción `APPROVE` y el SHA aprobado esperado. La lectura posterior a la publicación mostró `PUBLISHED`, consumo de la revisión, el mismo ID de artículo y la misma revisión aprobada.

La fila pública contiene el titular, resumen, explicación, cuerpo y fuente del paquete corregido. La versión original con el defecto editorial no es el cuerpo público. Hay tres artículos publicados tras la operación (dos antes); los fingerprints de los dos anteriores no cambiaron; no hay una segunda publicación para el evento ni revisiones duplicadas. El artículo de Astra sigue archivado. No se creó ningún intento del pipeline.

Publisher usa el mutex diario de publicaciones mediante una fila de `scheduler_runs`. Por tanto, la contabilidad precisa es **una fila de mutex manual** (`supervised-human-review-publish:2026-10-21`, `succeeded`, `dry_run=true`, `publish=false`), con `pipeline_run_id=null`, cero intentos de evento y cero solicitudes; no se ejecutó un trabajo del scheduler ni una ejecución del pipeline. La fila se creó como parte de la protección interna del Publisher.

La ruta local de producción `/noticias/india-detecta-actividad-de-agentes-de-ia-no-autorizados` respondió HTTP 200 y mostró el titular, resumen, explicación, cuerpo y fuente. La consola de navegador no se probó: no había runtime de automatización de navegador instalado.

## Validación local

Pasaron las pruebas unitarias M39, M31, M32, M34, revisión humana y Publisher; lint, `tsc --noEmit`, build de producción, auditoría de secretos y `git diff --check`. El build señaló que `NEXT_PUBLIC_SITE_URL` no estaba configurada y desactivó la indexación, condición ya permitida por el alcance. Auditoría de secretos: cero hallazgos. La comprobación de ruta fue una lectura HTTP local; no implicó cambios en datos.

El artefacto estructurado con IDs, hashes, conteos, reconciliaciones y estado final está en [`artifacts/supervised-cycle-12f12p-approve-publish.json`](../artifacts/supervised-cycle-12f12p-approve-publish.json).
