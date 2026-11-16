# 12F.12G — Diagnóstico de transporte de red de Supabase

## Resultado

Clasificación: `DNS_RESOLUTION_FAILURE`. La resolución del hostname configurado falló desde Node y desde las herramientas de Windows. No se recibió respuesta HTTP; por tanto no se intentaron TCP/TLS hacia una dirección resuelta, no se hizo lectura pública o privilegiada y no se ejecutó la preflight canónica.

Hostname: `skrthgpurquypgdwxast.supabase.co`.

## Causa segura de Node fetch

Una solicitud GET de Node a `https://<hostname>/` sin credenciales reprodujo el fallo usando el fetch global, sin el wrapper del runner:

| Campo | Error | Causa |
| --- | --- | --- |
| `name` | `TypeError` | `Error` |
| `message` | `fetch failed` | `getaddrinfo ENOTFOUND skrthgpurquypgdwxast.supabase.co` |
| `code` | `null` | `ENOTFOUND` |
| `errno` | `null` | `-3008` |
| `syscall` | `null` | `getaddrinfo` |
| `hostname` | `null` | `skrthgpurquypgdwxast.supabase.co` |
| `address` | `null` | `null` |
| `port` | `null` | `null` |

La preflight 12F.12F anterior también falló con `REMOTE_REQUEST_FAILED` y `TypeError: fetch failed`. Su wrapper registró cuatro intentos GET internos a `/rest/v1/regions`; eso fue una sola invocación del runner.

## DNS, IPv4 e IPv6

- Node `dns.lookup`: FAIL, `ENOTFOUND`.
- Node `dns.resolve4`: FAIL, `ETIMEOUT`.
- Node `dns.resolve6`: FAIL, `ETIMEOUT`.
- Windows `Resolve-DnsName`: los tipos A y AAAA fallaron.
- Direcciones obtenidas: IPv4 0, IPv6 0. No se imprimió ninguna dirección.
- Las pruebas TCP por familia no eran posibles sin una dirección resuelta.

## HTTPS, clientes y TLS

- Node global fetch: FAIL; la causa fue DNS `ENOTFOUND`.
- `curl.exe` 8.21.0 para Windows (Schannel): FAIL, código 6, “Could not resolve host”; HTTP `000`.
- PowerShell HTTP: no usado; `Resolve-DnsName` se usó para contrastar DNS.
- TCP: no alcanzado porque la resolución falló.
- TLS y validación de certificado/hostname: no alcanzados; no se desactivó la verificación TLS.
- No se obtuvo una respuesta HTTP ni PostgREST.

## Proxy y runtime

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` y `NO_PROXY` estuvieron ausentes tanto en el entorno de Node como en el de PowerShell. Node fue `v22.14.0`, Undici `6.21.1`, Next.js `16.3.4`; el camino del runner usa el fetch global de Node.

Supabase usa su wrapper SDK habitual `fetchWithAuth`, que agrega headers de autenticación y delega a `globalThis.fetch` mediante `resolveFetch`. `createSupabaseServerClient` no pasa una implementación fetch ni dispatcher personalizados. El runner protegido envuelve `globalThis.fetch` para allowlist y telemetría, y delega al fetch original. La misma falla DNS se reprodujo con el fetch global directo, así que no hay evidencia de que ninguno de esos wrappers cause el fallo.

## Fix y lecturas remotas

No se aplicó un fix de aplicación ni se cambiaron DNS, proxy, TLS o configuración del sistema. No hay evidencia de un defecto local de transporte que justifique un cambio de código. El allowlist de `/rest/v1/regions` ya estaba corregido y cubierto por regresión en 12F.12F.

- Lectura pública sin credenciales: no alcanzó HTTP por fallo DNS.
- Lectura privilegiada canónica: `NOT_RUN`, porque el transporte no está sano.
- Preflight canónica: 0 invocaciones en 12F.12G; condición de transporte sano no cumplida.
- Intento `4658d5c0-857c-4ed5-b97f-afb133b2bf22`: no revalidado; último estado durable conocido `DEFERRED_PROVIDER_CAPACITY`, etapa Critic, generación 1.
- Baseline: no leído en esta fase.
- Claims 0; resumes 0; proveedores 0; escrituras remotas 0; scheduler runs 0; nuevos intentos 0.
- `READY FOR CRITIC RESUME`: NO.

## Tests y gates locales

- Diagnóstico DNS/Node/curl: PASS como diagnóstico; el transporte remoto reporta FAIL.
- Observabilidad de errores remotos: PASS.
- Guard de rutas/read-only: PASS.
- Cliente Supabase aislado/mock: PASS; solicitudes externas 0.
- Read path M32 en fixtures: PASS.
- Lint: PASS.
- TypeScript: PASS.
- Build: PASS.
- `git diff --check`: PASS.
- Auditoría de secretos: PASS; hallazgos 0; `.env.local` ignorado.
