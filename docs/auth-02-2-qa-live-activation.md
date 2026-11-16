# AUTH-02.2 — Despliegue QA privado y activación editorial live

**Resultado: PARCIAL, BLOQUEADO POR ALCANCE. LIVE EDITORIAL READINESS = NO.** El artefacto Netlify limpio pasa la auditoría y la CLI está autenticada. La consulta dirigida al único sitio enlazado confirmó `horizai-lr02-qa-preview` y su hostname HTTPS. Sin embargo, el proyecto Supabase asociado al entorno local aparece en el Dashboard como `main PRODUCTION`. La autorización excluye producción, así que se detuvo antes de cambiar Supabase, transferir credenciales al QA, desplegar o solicitar OTP.

**Actualización 2026-10-22:** tras la confirmación explícita del usuario, `netlify login` terminó correctamente y una llamada API dirigida al ID ya enlazado confirmó el nombre exacto del sitio QA, `https://horizai-lr02-qa-preview.netlify.app`, sin dominio personalizado. No se listaron otros sitios. La preflight Auth del proyecto Supabase confirmó `disable_signup=true` y el proveedor de email habilitado. La organización Supabase tiene una única cuenta miembro y la identidad activa de Netlify coincide, verificado sin imprimirla; esto cumple la restricción de destinatario del mailer gratuito predeterminado, aunque la entrega real no se probó. El selector del Dashboard de Supabase identifica el proyecto asociado al entorno local como `main PRODUCTION`; ese conflicto con la prohibición de producción es un bloqueo obligatorio. Se detuvo antes de mutar Supabase o Netlify, transferir secretos, desplegar, crear usuarios, solicitar OTP o hacer lecturas M32. El staging local sigue limpio: sin `.env.local`, `.git`, `docs`, `artifacts`, `netlify/` ni los paquetes antiguos. El build oficial de Netlify con Next Runtime 5.16.3 pasó; la auditoría de 2.241 archivos publicados encontró cero valores privados de `.env.local`, patrones de credenciales, archivos `.env.local` o ZIP antiguos. El artefacto no se subió.

## OBSERVE

- La API de Netlify confirmó que el ID enlazado corresponde exactamente al sitio `horizai-lr02-qa-preview`, con hostname `https://horizai-lr02-qa-preview.netlify.app` y sin dominio personalizado. No se consultaron otros sitios. No se hizo un nuevo deploy ni se verificó que ese hostname sirva la app.
- `netlify.toml` solo fija Node.js 22. No define comando de publicación, directorio público ni funciones. La raíz del repositorio no es un directorio de deploy aceptable.
- `/.netlify/` está ignorado por Git y `.env*` está ignorado salvo `.env.example`; esas reglas no protegen un deploy manual.
- El contenido local de `.netlify/functions/___netlify-server-handler.zip` es antiguo y contiene `.env.local` y categorías de credenciales privadas. `scheduler-trigger.zip` también es antiguo. No se subió ninguno. La carpeta está desfasada respecto del código actual.
- El incidente histórico documentado en `docs/netlify-preview-exposure-incident.md` confirma que una publicación anterior de la raíz sirvió código, documentación y artefactos cuando el proyecto se hizo público. Se debe tratar como un requisito de seguridad: construir un paquete actual con superficie explícita y verificarlo antes de cualquier upload.
- La CLI oficial de Netlify terminó `login` correctamente y pudo consultar el sitio exacto por su ID enlazado. La credencial local no se mostró ni registró.
- Estado heredado de AUTH-02.1 y preflight actual: signup público desactivado; proveedor Email habilitado; Site URL aún `http://localhost:3000`; redirects vacíos; SMTP propio apagado y mailer predeterminado activo. El envío gratuito está restringido a miembros de la organización y a su límite vigente; la elegibilidad está verificada, pero no la entrega. El proyecto mostrado en el Dashboard es `main PRODUCTION`, por lo que queda prohibido modificarlo bajo el alcance actual.

## PLAN Y EJECUCIÓN

Se mantuvo el estado remoto sin cambios y se ejecutó la verificación local solicitada. No se reutilizaron los ZIP actuales. El empaquetado fresco de Next Runtime pasó y su salida auditada no contiene secretos. La preflight halló que la URL local de Supabase apunta al proyecto cuya rama activa se etiqueta `main PRODUCTION`. Se detuvo en ese punto; la autorización de QA no permite cambiar su Auth ni usar su credencial privilegiada desde un deploy QA.

Gates disponibles:

| Gate | Resultado |
| --- | --- |
| AUTH-01 unit | PASS — 8 |
| UI-06 unit | PASS — 11 |
| UI-07 unit | PASS — 10 |
| AUTH-02 focused | No se encontró un script dedicado |
| `npm run lint` | PASS |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS; advertencia existente: `NEXT_PUBLIC_SITE_URL` ausente o inválida |
| `git diff --check` | PASS; solo avisos de normalización LF/CRLF |
| `node scripts/safe-secret-audit.mjs` | PASS — 1.119 archivos escaneados, 0 archivos con hallazgos; `.env.local` ignorado |

## CRITIQUE Y LÍMITES

No se debe desplegar la raíz ni reutilizar los ZIP actuales: uno incluye `.env.local` dentro de la función SSR y el otro corresponde al scheduler. Aunque la auditoría de secretos del árbol pasó y Git ignora `.env.local`, eso no neutraliza los archivos ya empacados ni demuestra qué enviaría Netlify. La configuración `netlify.toml` tampoco limita el directorio de publicación.

El hostname HTTPS no sirve una app según la observación anterior. Por tanto, todavía no se puede comprobar el login, los redirects, las rutas privadas, el estado anónimo, el HTML/RSC, los bundles, la caché, el logout ni la respuesta visual en los tamaños requeridos. El mailer predeterminado está configurado, pero su entrega real sigue **UNKNOWN**; no se envió correo para probarlo.

## Estado de activación

| Campo | Resultado |
| --- | --- |
| `qaDeploy` | NOT_RUN; deploys nuevos: 0; producción: 0; CLI autenticada y sitio exacto verificado por ID |
| `qaOrigin` | Hostname HTTPS conocido y sin dominio personalizado; aplicación aún no desplegada/verificada |
| `deploySecurity` | No aprobado para deploy; `netlify.toml` sin publish dir; salida de función obsoleta contiene `.env.local`; ningún artefacto se subió |
| `supabaseUrlConfig` | Inalterado: localhost, redirects vacíos; signup desactivado. Proyecto actual etiquetado `main PRODUCTION`; bloquea esta autorización QA |
| `operatorAllowlist` | No configurada; count 0; no se transfirió identidad |
| `emailDelivery` | Elegibilidad del mailer predeterminado confirmada para la identidad de la cuenta; entrega UNKNOWN; 0 mensajes |
| `otp` | NOT_RUN; 0 solicitudes |
| `session` | NOT_RUN |
| `liveDataActivation` | OFF |
| `m32` | NOT_RUN; 0 lecturas reales; 0 mutaciones |
| `anonymousSecurity` | No probado en QA live; las pruebas AUTH-01/UI-06/UI-07 sintéticas pasan |
| `clientSecurity` | PASS solo en las pruebas sintéticas UI-07; inspección live no ejecutada |
| `logout` | NOT_RUN |
| `visualQA` | INCOMPLETE; no hay app QA utilizable |
| `cost` | €0 en esta fase |
| Decisiones / approve / hold / reject / revisiones | 0 / 0 / 0 / 0 / 0 |
| Publicaciones / push / llamadas a proveedores | 0 / 0 / 0 |
| Ejecuciones pipeline / scheduler / migraciones | 0 / 0 / 0 |

## Bloqueo y siguiente paso

No hay cambios externos que revertir. Para continuar dentro del alcance autorizado hace falta identificar un proyecto Supabase QA existente, con URL y credenciales propias de QA, o una nueva autorización explícita que amplíe el alcance al proyecto Supabase `main PRODUCTION`. No se consultaron otras ramas/proyectos de Supabase. La autorización actual excluye producción, así que esa ampliación no se presume. Tras identificar un backend QA, deben repetirse sus preflight de signup, mailer y redirects antes de configurar variables Netlify, desplegar o solicitar OTP.

**AUTH-02.2: PARTIAL. LIVE EDITORIAL READINESS = NO. READY FOR UI-08 REAL DECISIONS = NO.**
