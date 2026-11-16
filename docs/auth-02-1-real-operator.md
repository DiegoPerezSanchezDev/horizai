# AUTH-02.1 — Activación real del operador editorial

**Resultado: PARCIAL. LIVE EDITORIAL READINESS = NO.** Se desactivó y verificó el signup público en Supabase. No existe una app desplegada en el proyecto privado de QA, así que faltan un origen HTTPS funcional, el operador configurado, el OTP real y la primera lectura M32. La flag live sigue apagada.

## OBSERVE

El proyecto Supabase conectado al entorno local tenía habilitado el signup general. Email estaba habilitado, la confirmación era obligatoria y los sign-ins anónimos estaban desactivados. Supabase conservaba `http://localhost:3000` como Site URL, sin redirect URLs, y usaba el mailer predeterminado sin SMTP propio.

El dashboard de Netlify contiene el proyecto privado `horizai-lr02-qa-preview` y su hostname HTTPS, pero el proyecto indica que aún no se ha desplegado. Al abrir el hostname, Netlify responde **Site not found**. El panel de variables no contiene `EDITORIAL_OPERATOR_EMAILS`, `EDITORIAL_AUTH_ORIGIN`, `NEXT_PUBLIC_SITE_URL` ni `EDITORIAL_LIVE_DATA_ENABLED`.

La identidad de la cuenta que ya tenía acceso al dashboard Supabase no aparece entre los usuarios Auth del proyecto. No se creó ni invitó ninguna cuenta. El entorno local tampoco tiene una allowlist de operadores ni una sesión QA autorizada.

## PLAN

La corrección acotada autorizada era desactivar el signup global y verificar la configuración. Mantener el flag live apagado hasta contar con una app QA accesible, un origen exacto, un operador Auth existente y todos los controles de sesión. No cambiar producción, M31–M39, datos ni decisiones editoriales.

## EXECUTE

- Se apagó **Allow new users to sign up** en Authentication y se recargó la página para verificar que quedó desactivado.
- Se comprobó que Email sigue habilitado, la confirmación de email sigue siendo obligatoria y los sign-ins anónimos siguen desactivados.
- Se confirmó que SMTP personalizado está apagado y el proyecto usa el mailer predeterminado de Supabase.
- No se configuraron Site URL o redirects con el hostname de QA: todavía no sirve la app y responde 404. No se configuraron variables privadas ni se activó la flag live.
- No se envió OTP, no se creó usuario, no se consultó M32 y no se accedió a la bandeja ni al detalle en modo live.

## CRITIQUE

La barrera de signup público quedó cerrada. Autorizar la URL que hoy devuelve 404 produciría una configuración de Auth que no puede completar el callback ni demostrar HTTPS operativo. También falta una identidad Auth existente para la cuenta autorizada; la ruta de login solicita `shouldCreateUser: false`, por lo que no debe reabrirse el signup público para resolverlo.

El mailer predeterminado está configurado, pero el envío real y la recepción no se probaron. Supabase documenta que su servicio predeterminado es limitado y está destinado a miembros del equipo; por ello no se registra como entrega verificada ([configuración de SMTP de Supabase](https://supabase.com/docs/guides/auth/auth-smtp)). Los redirects admitidos dependen de los patrones configurados en Auth URL Configuration ([redirect URLs de Supabase](https://supabase.com/docs/guides/auth/redirect-urls)).

## VERIFY

La protección de operador requiere identidad verificada, allowlist exacta y rechaza identidades anónimas. Las páginas editoriales son dinámicas y las lecturas privadas usan `no-store`. Las pruebas AUTH-01, UI-06 y UI-07 validan estas fronteras con identidades y datos sintéticos; no sustituyen la comprobación HTTP bajo una sesión live. AUTH-01 conservaba además una integración local aislada previa de 15 casos, que no se repitió porque falta `.auth-01-local/runtime.json` y el socket de Docker no está disponible.

| Gate | Resultado de esta fase |
| --- | --- |
| Signup público | **DESACTIVADO**, guardado y verificado tras recarga |
| Auth anónimo | **DESACTIVADO**; rechazo live no probado en este turno |
| Email / confirmación | **HABILITADO / OBLIGATORIA** |
| Operadores allowlist | **0**; no configurada |
| Origen HTTPS y redirects | **PENDIENTES**; hostname QA aún sin deploy y redirects vacíos |
| Entrega de email | **DESCONOCIDA**; mailer predeterminado, sin envío real |
| OTP / sesión real | **NO EJECUTADOS** |
| Flag M32 | **OFF** |
| Lectura M32 / inbox / detalle | **NO EJECUTADOS** |
| DTO y exposición en cliente | PASS en pruebas sintéticas UI-07; inspección live no ejecutada |
| Caché | PASS por código/pruebas UI-07; respuesta autenticada live no ejecutada |
| Visual QA live | **INCOMPLETE_VISUAL_QA**, sin origen QA desplegado |

Intenté la prueba HTTP local anónima de UI-06 contra el servidor esperado en `127.0.0.1:3016`; el sandbox rechazó la conexión con `EACCES` antes de que llegara a la aplicación. Por eso no la contabilizo como PASS ni como una respuesta DENIED verificada.

Comandos y resultados de integridad del repositorio para esta fase:

- AUTH-01: 8 grupos de pruebas; UI-06: 11; UI-07: 10.
- `npm run lint`: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS; el build necesitó acceder a las fuentes remotas ya declaradas por el proyecto.
- `node scripts/safe-secret-audit.mjs`: PASS; cero archivos con hallazgos y `.env.local` ignorado por Git.
- `git diff --check`: PASS.
- El control HTTP anónimo de rutas, OTP real, inspección de red de una sesión live y QA visual live siguen pendientes; no se afirman como probados.

## Estado registrado

| Campo | Resultado |
| --- | --- |
| `projectAuthStateBefore.publicSignup` | ENABLED |
| `projectAuthStateBefore.anonymousSignIns` | DISABLED |
| `projectAuthStateBefore.emailProvider` | ENABLED |
| `projectAuthStateBefore.emailConfirmation` | REQUIRED |
| `projectAuthStateBefore.siteUrl` | `http://localhost:3000` |
| `projectAuthStateBefore.redirectUrls` | NONE |
| `projectAuthStateBefore.smtp` | DEFAULT_SUPABASE_MAILER; CUSTOM_SMTP_OFF |
| `signupChange` | DISABLED; PERSISTENCE_VERIFIED_AFTER_RELOAD |
| `operatorAllowlist` | NOT_CONFIGURED; operator count 0; no identity written to files |
| `httpsOrigin` | FAIL; private QA project exists but has no deployment; hostname responds SITE_NOT_FOUND |
| `redirectConfig` | FAIL; no QA Site URL or redirect URL configured |
| `emailDelivery` | UNKNOWN; default mailer configured, no test email sent |
| `otpRequest / otpCompletion` | NOT_RUN / NOT_RUN; 0 requests |
| `sessionValidation` | NOT_RUN for a real operator session |
| `liveDataActivation` | OFF; no QA flag change |
| `realM32Read` | NOT_RUN; 0 live reads |
| `liveInbox / realDetail` | NOT_RUN / NOT_RUN |
| `anonymousSecurity` | Sign-ins disabled; code/synthetic tests reject anonymous users; live QA HTTP test not run |
| `clientDataSecurity` | No exposure found by synthetic UI-07 checks; live network inspection not run |
| `logout` | NOT_RUN for a live session; prior AUTH-01 local integration passed |
| `privateCaching` | PASS by code and UI-07 tests; authenticated live reuse test not run |
| `visualQA` | INCOMPLETE_VISUAL_QA |
| `projectAuthStateAfter` | Signup DISABLED; anonymous DISABLED; email ENABLED; confirmation REQUIRED; localhost Site URL; no redirects; default mailer |

No secrets, operator email, OTP, session token or raw M32 payload was written to this report or its JSON artifact.

## Acción manual requerida

Completar el primer deploy **solo** en el proyecto privado QA existente `horizai-lr02-qa-preview` para que su hostname HTTPS sirva la aplicación, y avisar cuando la URL responda correctamente. Esto no requiere ni autoriza un deploy de producción. La configuración de Auth, el OTP único y las lecturas M32 podrán continuar después de verificar ese origen.

**LIVE EDITORIAL READINESS = NO. READY FOR UI-08 REAL DECISIONS = NO.** Decisiones editoriales 0; mutaciones 0; publicaciones 0; push 0; llamadas a proveedores 0; ejecuciones de pipeline 0; ejecuciones de scheduler 0; migraciones 0; deploys de producción 0.
