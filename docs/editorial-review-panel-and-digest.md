# Panel editorial con decisiones y notificación detallada

## Qué existía (OBSERVE)

- **Panel**: `/editorial` ya existía (login por código OTP de Supabase Auth + lista de operadores `EDITORIAL_OPERATOR_EMAILS`, `proxy.ts` + `requireEditorialOperator()`), de **solo lectura**. No se creó un `app/admin` paralelo: se ha extendido ese panel.
- **Retirada de noticias publicadas** («ocultar»): `/editorial/publicadas`, protegida por `EDITORIAL_WITHDRAWAL_ENABLED`, registrada (motivo, nota, operador, fecha) y reversible. No se ha tocado.
- **Notificaciones**: solo existían `lib/editorial/notifications.ts` (payload mínimo «preparado», sin entrega) y `notification-client.ts` (observa permisos del navegador). **No hay ninguna infraestructura de envío** (ni email, ni SMTP, ni webhook, ni push, ni dependencia de correo).
- **CLI**: `npm run pipeline:human-review -- status|list|inspect|approve|hold|reject|publish-approved`.

## Qué hay ahora

### Lógica compartida (una sola fuente de verdad)

`lib/agents/publisher/human-review-operations.ts` contiene las reglas que antes vivían dentro de la CLI y que ahora usan **la CLI y el panel**: identidad/hash del paquete (`expected-package-sha256`), checkpoints vigentes, las siete comprobaciones (`facts, attribution, uncertainty, headline, summary, unsupported-claims, source-chain`), hash de la revisión corregida, estado permitido, límite de 2 publicaciones por día UTC y el *lease* diario (`supervised-human-review-publish:<fecha>`, que además excluye una publicación simultánea desde la CLI). Las E/S (Supabase, raíces de artefactos, reloj) se inyectan, por lo que se prueba con dobles. La CLI (`scripts/pipeline-human-review.ts`) es ahora un envoltorio fino y sigue exportando `assertRowArtifactMatch`.

### Panel `/editorial`

| Pantalla | Qué muestra |
| --- | --- |
| Bandeja | Pendientes con puntuación, motivo de la elección y estado; sección **Aprobadas · listas para publicar** (selección de 1–2 y botón «Publicar seleccionadas») y **En espera**. |
| Detalle `/editorial/reviews/<id>` | Texto completo, fuentes, **por qué se eligió** (puntuación del Ranker y desglose, `rankReason`), verificación (hechos verificados, incertidumbres, contradicciones), crítico (notas, observaciones, afirmaciones sin respaldo), avisos, SHA-256 del paquete y del objetivo, y el formulario de decisión. |
| Decisión | Siete casillas + confirmación; **Aprobar / Poner en espera / Rechazar**. Aprobar exige las siete; no publica. Publicar es un paso aparte (máx. 2/día UTC). |
| Publicadas | `/editorial/publicadas`: ocultar/restaurar (mecanismo de retirada existente). |

Las puntuaciones, motivos, hechos e incertidumbres se **copian del paquete de revisión verificado** (`reviewEvidence`); si faltan, no se muestran ni se inventan.

### Seguridad de las acciones de escritura

`POST /editorial/decisiones` (`app/editorial/(workspace)/decisiones/route.ts`), en este orden: comprobación de origen (`Origin`/`Sec-Fetch-Site`) → operador verificado de la sesión (además del `proxy.ts`) → flags → formulario estricto (claves permitidas, UUID, SHA-256, tamaño máximo 4 KB) → operaciones compartidas. El revisor registrado es el **email de la sesión**, nunca un campo del formulario. La clave de servicio solo se usa en el servidor; el HTML no lleva secretos (formularios renderizados en servidor, sin JavaScript de cliente). Las respuestas usan códigos seguros: nunca se reenvía texto de error en bruto. Redirección solo a destinos fijos.

**Activación (apagada por defecto)**: `EDITORIAL_DECISIONS_ENABLED=true` **y** `EDITORIAL_LIVE_DATA_ENABLED=true` (ambos exactamente `true`). Sin ellos los botones aparecen desactivados y el endpoint responde `disabled`.

### Cómo entrar

1. Variables privadas del servidor: `EDITORIAL_OPERATOR_EMAILS` (tu email verificado), `EDITORIAL_AUTH_ORIGIN`, claves de Supabase, y para decidir las dos flags anteriores.
2. Abre `/editorial/login`, introduce tu email (debe estar en la lista) y el código que llega por correo.
3. Los paquetes (`HUMAN_REVIEW_ARTIFACT_ROOT`) y los checkpoints (`HUMAN_REVIEW_CHECKPOINT_ROOT`, por defecto `artifacts/pipeline-checkpoints`) deben estar **en el sistema de archivos del servidor que ejecuta el panel**. Hoy viven en el portátil, así que el panel con decisiones funciona donde esos directorios existan (p. ej. `next start` local), no en un despliegue sin ellos (lo mismo que ya exigía la lectura en vivo, ver `docs/ui-07-live-editorial-data.md`).

## Notificación detallada

`lib/editorial/review-digest.ts` es una función pura `buildEditorialReviewDigest(reviews, opciones) → { subject, text, html }`. Por cada candidata: titular, resumen, por qué importa, país/región, categoría, puntuación del Ranker con desglose y motivo, verificación, crítico, hechos verificados, incertidumbres, contradicciones, avisos del guard y del crítico, fuentes con enlace, id de revisión, SHA-256 del paquete y enlace al panel. Pie con el contacto del medio (`d.perez.sanchez.dev@gmail.com`). El HTML escapa todo y solo enlaza `http(s)`.

```bash
npm run editorial:digest -- --sample                      # ejemplos inventados, sin base de datos
npm run editorial:digest                                  # pendientes reales (solo lectura)
npm run editorial:digest -- --format=html --base-url=https://<origen-del-panel>
```

**Qué falta para enviarlo por email**: un proveedor de correo (SMTP o API) con remitente verificado y credenciales en variables de entorno privadas, un destinatario configurado y un disparador (cron/post-ejecución del pipeline) con deduplicación (`editorialNotificationDedupeKey` ya existe). Nada de esto está contratado ni configurado; el script solo imprime. Los correos de Supabase Auth (códigos de acceso) no sirven para mensajes propios.

## Tests

`npm run human-review:operations:unit` · `npm run editorial:decisions:unit` · `npm run editorial:digest:unit` (además de `editorial-ui-06/07`, `editorial:withdrawal:unit` y `supervised-human-review:read-path:migration32:unit`, que siguen pasando).
