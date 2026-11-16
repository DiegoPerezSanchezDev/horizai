# FASE 12F.12G.1 — DNS local, transporte Supabase y un preflight

Fecha: 20 de octubre de 2026. Host: `skrthgpurquypgdwxast.supabase.co`.

## Resultado

DNS: **DNS_HEALTHY**. Transporte: **TRANSPORT_HEALTHY**. La lectura privilegiada M32 obtuvo **HTTP 200**.

Se ejecutó exactamente **un preflight canónico**, que terminó en **FAIL / LOCAL_PREFLIGHT_FAILURE** por `DAILY_REQUEST_CAP_MISMATCH`: límite diario efectivo **1000**, frente a **18** exigido por el runner. Las dos lecturas del preflight recibieron HTTP 200; el fallo es una aserción local posterior. No se cambió el límite y no se repitió el preflight.

**READY FOR CRITIC RESUME: NO.** El intento y la baseline no llegaron a leerse ni revalidarse en esta fase.

## OBSERVE → PLAN

Objetivo: determinar si la máquina local puede resolver y alcanzar Supabase, y ejecutar una única preflight de solo lectura si la lectura privilegiada funciona. La capa afectada es transporte/diagnóstico; interfaz, responsive y temas no aplican.

- CRITICAL: el fallo de transporte conocido requería contrastar DNS y HTTPS actuales. Las pruebas fuera del sandbox demostraron conectividad.
- IMPORTANT: la rama de observabilidad del runner usaba `snapshot` antes de inicializarlo. Se corrigió antes de consumir la única invocación.
- IGNORE: cambios visuales, arquitectura de aplicación, DNS/router, claves, ACL, migraciones, scheduler y ejecución de Critic quedan fuera del alcance.
- Plan: usar el entorno normal, contrastar resolvers y clientes, una lectura M32, archivos exclusivos de fase y un único preflight con retorno anterior a claim/resume. Mantener todos los límites de no escritura y documentar cualquier bloqueo.

## Entorno y DNS

Se extrajo únicamente el hostname de `NEXT_PUBLIC_SUPABASE_URL`, que es la variable usada por `createSupabaseServerClient`, mediante `node --env-file-if-exists=.env.local`. El alias `SUPABASE_URL` está ausente. No se imprimió ni modificó el archivo de entorno.

| Prueba en la máquina, fuera del sandbox | Resultado | Evidencia |
| --- | --- | --- |
| Windows Resolve-DnsName | PASS | Dos direcciones IPv4 |
| nslookup predeterminado | PASS | Resolver 8.8.8.8; dos IPv4 |
| Cloudflare 1.1.1.1 | PASS | Dos IPv4 |
| Google 8.8.8.8 | PASS | Dos IPv4 |
| Node dns.lookup, all: true | PASS | Dos direcciones, familia 4 |
| Node dns.resolve4 | PASS | Dos direcciones |
| Node dns.resolve6 | FAIL | ENODATA: no respuesta AAAA |

Clasificación única: **DNS_HEALTHY**. La ausencia de AAAA no impide usar las respuestas A: ambos clientes HTTPS alcanzaron el origen por el camino normal. No se fijó ninguna IP ni se usó un resolver público como sustituto del resolver del sistema.

Las primeras pruebas dentro del sandbox devolvieron acceso denegado en Resolve-DnsName, falta de acceso CIM para adaptadores, ENOTFOUND en Node lookup y timeouts en consultas directas. Al repetir las mismas comprobaciones de solo lectura fuera de ese entorno restringido, IPv4 funcionó en todos los resolvers. Esos fallos del sandbox no prueban un problema DNS/router de la máquina ni intermitencia real. Este resultado tampoco permite atribuir retrospectivamente una causa distinta al diagnóstico anterior.

## Estado de Windows, solo lectura

Se inspeccionaron `ipconfig /all`, `Get-DnsClientServerAddress`, adaptadores activos, ruta por defecto y valores de configuración DNS del registro. No se imprimieron MAC, IP locales, gateways, sufijos ni otros datos de adaptadores ajenos al diagnóstico.

La ruta preferida es **Wi-Fi**, métrica 0. Tiene DNS **MANUAL**: **8.8.8.8 y 8.8.4.4**. `dnsServersCount=2` corresponde a esta interfaz efectiva. La ruta virtual ZeroTier tiene métrica 9999.

| Adaptador activo | DNS devueltos por Get-DnsClientServerAddress | Modo observado |
| --- | --- | --- |
| Wi-Fi | 8.8.8.8, 8.8.4.4 | MANUAL |
| Ethernet 2 | fec0:0:0:ffff::1, ::2, ::3 con el mismo prefijo | UNKNOWN |
| vEthernet (Default Switch) | fec0:0:0:ffff::1, ::2, ::3 con el mismo prefijo | UNKNOWN |
| ZeroTier One [ebe7fbd445fa3e7d] | fec0:0:0:ffff::1, ::2, ::3 con el mismo prefijo | UNKNOWN |

Hay 11 entradas y 5 direcciones distintas al contar todos esos adaptadores. Las entradas fec0 devueltas por el cmdlet no aparecieron en ipconfig /all y no fueron el resolver elegido por nslookup. No se deduce DHCP de esos valores.

**DNS cache flushed: NO.** No se cumplía la condición para vaciarla: el resolver predeterminado ya funcionaba. Cambios de DNS/router: 0.

## HTTPS y comparación de clientes

| Cliente | Transporte | HTTP | Credenciales |
| --- | --- | --- | --- |
| curl.exe -I, connect-timeout 10, max-time 20 | PASS, exit 0 | 404 | Ninguna |
| Node global fetch, timeout 20 s | PASS | 404 | Ninguna |

Una respuesta 404 en la raíz prueba que DNS/TCP/TLS/HTTP llegaron al origen; no se interpreta como fallo de transporte. `nodeVsSystem=BOTH_PASS`. Validación TLS conservada; sin overrides, IP fija ni cambios de proxy.

## Lectura privilegiada y única preflight

La prueba de aplicación usó el factory existente `createSupabaseServerClient` y una única llamada a `get_pipeline_human_review_operator_status`.

- HTTP 200; PASS; una solicitud.
- PostgREST code/message/details/hint: null.
- Guard: origen exacto, ruta RPC M32 exacta, método POST y máximo una solicitud. Cualquier otra operación se bloqueaba antes de fetch.

Tras pasar DNS, ambos clientes HTTPS y esta lectura, se invocó una sola vez:

```text
node --env-file-if-exists=.env.local --conditions=react-server --experimental-strip-types scripts/supervised-cycle-12f12e-critic-resume.mjs --dns-recovery-preflight-12f12g1
```

La opción activa la misma rama canónica de observabilidad/preflight de solo lectura, con archivos propios de 12F.12G.1 y protección contra sobrescritura de evidencia anterior. El guard conserva únicamente las lecturas autorizadas durante PREFLIGHT; la rama retorna antes del código de claim/resume.

Lecturas de esta única invocación:

| Método | Ruta | HTTP |
| --- | --- | --- |
| GET | /rest/v1/regions | 200 |
| HEAD | /rest/v1/agent_logs | 200 |

Se detuvo en `baselineRead` por `DAILY_REQUEST_CAP_MISMATCH: 1000 !== 18`, con AssertionError / ERR_ASSERTION. `pipeline.preflight()` terminó y devolvió conexión Supabase válida; falló la comprobación local posterior de configuración. No hubo error HTTP/PostgREST ni TLS.

Invocaciones del runner/preflight: **1/1**. Lecturas autenticadas totales de esta fase: **3** (M32 inicial 1 + preflight 2). Reintentos de preflight: **0**.

## Intento y baseline

Intento objetivo: `4658d5c0-857c-4ed5-b97f-afb133b2bf22`.

| Campo | Resultado actual |
| --- | --- |
| Attempt revalidated | NO |
| Estado / etapa / generación | No revalidados; últimos confirmados: DEFERRED_PROVIDER_CAPACITY / Critic / 1 |
| Cinco checkpoints | NA; último estado confirmado PASS para Verifier, Translator, Editor, Classifier y Ranker |
| Critic checkpoint / dispatch | NA; último estado confirmado ABSENT / false |
| Event y pipeline_run lineage | No revalidados |
| Accounting histórico | 5 requests / 8365 tokens, dato previo sin revalidar |
| Baseline | NA / NOT_RUN |

Los valores de baseline solicitados (19 intentos, 0/1/0 activos/diferidos/atascados, reviews/WAITING 0/0, públicos 2, Astra ARCHIVED, reservas desconocidas 0 y fingerprints sin cambio) se conservan solo como **expectativas previas**, no como mediciones actuales. El fallo ocurrió antes de leer el intento y la baseline.

## EXECUTE → CRITIQUE

Solo se modificaron dos scripts de diagnóstico:

1. `scripts/supervised-cycle-12f12e-critic-resume.mjs`: opción de fase con rutas exclusivas y traslado de la emisión de evidencia de snapshot hasta después de su inicialización y validación.
2. `scripts/supervised-cycle-12f12f-runner-observability-unit-test.mjs`: ejecución del bloque real de validación del intento con lecturas en memoria, más cobertura de la opción de fase y la salida anterior a resume.

La prueba local llegó a la rama corregida y registró generación 1 y cero dispatches sin ReferenceError. La invocación remota no llegó a esa rama: detectó antes el límite diario discrepante. El desacuerdo 1000/18 queda registrado como bloqueo; no se amplió el alcance para modificar el entorno o repetir el preflight.

No hubo cambios en código de aplicación, recursos visuales, configuración de red o credenciales. La corrección local no implica que el intento esté listo para reanudarse.

## VERIFY

- Regresión del runner/guard, construcción canónica con fetch simulado y bloque real de validación del intento: PASS; 7 solicitudes simuladas, 0 escrituras simuladas.
- npm run lint: PASS.
- npx tsc --noEmit: PASS.
- npm run build: PASS.
- git diff --check: PASS.
- Auditoría de secretos: PASS; hallazgos 0; .env.local ignorado.
- Responsive, dark/light, consola del navegador y navegación: no aplicables; no hay cambios de UI.

Warnings observados: Node anuncia type stripping experimental y ausencia de tipo de módulo; el build avisa que NEXT_PUBLIC_SITE_URL falta o no es válido y desactiva metadata de indexación. No se modificaron ajustes ajenos al diagnóstico.

Evidencia: `artifacts/supervised-cycle-12f12g1-dns-recovery.json` y latch de invocación `artifacts/supervised-cycle-12f12g1-preflight-invocation.json`.

Claims **0**; resume invocations **0**; provider calls **0**; remote writes **0**; daily scheduler runs **0**; nuevos intentos **0**; publicaciones **0**; migraciones **0**; ACL changes **0**; rotaciones **0**.

**READY FOR CRITIC RESUME: NO. DETENERSE.**
