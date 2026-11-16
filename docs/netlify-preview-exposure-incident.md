# Incidente de exposición del deploy preview — LR-02B

## Evidencia preservada antes de eliminar el deploy

Captura: 2026-10-12 (UTC). Solo se conservaron metadata y rutas; no se copiaron cuerpos de archivos del deploy.

- Sitio: `horizai-lr02-qa-preview` (`53b30110-9020-4836-b043-d9306c3d7f96`).
- Deploy defectuoso: `6acb93b12bf071fd5ac32977`.
- URL permanente del deploy: `https://6acb93b12bf071fd5ac32977--horizai-lr02-qa-preview.netlify.app`.
- Tipo/estado observado en Netlify: Deploy Preview, completed; no publicado como producción.
- Creación: `2026-10-11T13:48:33.804Z`.
- Visibilidad del proyecto al capturar: Private; el HEAD anónimo del deploy dio HTTP 401.
- Deploy limpio conservado: `6acbb82ca8d2f5445d849138`, Deploy Preview completed, sin acción Publish.
- El dashboard muestra solo esos dos Deploy Previews y “Project has not yet been deployed”; no existe deploy de producción.
- Evidencia histórica de la exposición: se subió por error la raíz del repositorio (806 archivos). Se sabe que rutas de código, documentación y artefactos como `/package-lock.json`, `/docs/product-principles.md`, `/artifacts/netlify-preview-validation.json` y `/app/page.tsx` respondieron HTTP 200 mientras el sitio estuvo público.
- `/.env.local` respondió 404. La auditoría local de secretos registrada para la fase previa pasó con cero hallazgos.
- Netlify access logs para comprobar accesos externos no están disponibles. **Acceso externo por terceros: UNKNOWN.**
- El HEAD anónimo actual del deploy limpio también respondió HTTP 401 mientras el proyecto permanece privado.
- No se conserva contenido de archivos expuestos; las rutas anteriores bastan para documentar las categorías.

La eliminación del deploy defectuoso aún no se había ejecutado en el momento de esta captura.
