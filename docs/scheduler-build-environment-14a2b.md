# Fase 14A.2b — build environment isolation

## Resultado

**14A.2b: PASS.** El fallo original se clasifica como `WORKSPACE_FILESYSTEM_EPHEMERAL`: el build canónico pasó en una copia local no sincronizada, con hashes de fuente iguales a los del worktree original. No se necesitó cambiar `/contacto`, Next.js, M40 ni el scheduler.

**14A.2 implementation: PASS. Ready for 14A.3 remote M40: YES.** M40 sigue sin aplicar remotamente; 14A.3 deberá validar/aplicar M40 como fase separada. El scheduler y el workflow de GitHub siguen inactivos.

## originalFailure

El worktree original está en `C:\Users\Diego\OneDrive\Desktop\horizai\horizai`. Los dos intentos anteriores del build canónico compilaron y pasaron TypeScript, pero fallaron al prerenderizar `/contacto` con `EPERM` al crear `.next/server/app/contacto.segments/contacto`.

El fallo **no se reprodujo** en el build aislado. La diferencia observada es la ubicación del worktree; la configuración de aplicación y los archivos fuente relevantes conservaron sus hashes. Por ello, la evidencia soporta `WORKSPACE_FILESYSTEM_EPHEMERAL`, no un defecto de aplicación. El worktree de OneDrive permanece como fuente autorizada; los builds que requieran creación fiable de artefactos deben ejecutarse desde un workspace local no sincronizado.

## sourceWorkspace

Antes de actualizar los informes de cierre, se registró:

- Branch: `main`
- HEAD: `4352bfb9046914fa5d7b4451c1b1e664a2baeac7`
- `git status --short --untracked-files=all`: 1.831 entradas, 114 tracked modificadas y 1.717 untracked.
- Tracked relevantes: `app/contacto/page.tsx`, `next.config.ts`, `package.json`, `package-lock.json`.
- Untracked relevantes: migration M40, scheduler orchestrator, CLI, plantilla GitHub Actions y tests focalizados M40/scheduler.

El conteo corresponde a la captura de preflight; la actualización y creación de los informes 14A.2b añade los artefactos de documentación solicitados. La rama y HEAD no cambiaron. No se limpiaron, reiniciaron ni descartaron archivos originales.

## isolatedWorkspace

Se usó la carpeta temporal local no sincronizada:

`C:\Users\Diego\.codex\visualizations\2026\10\05\01a10da8-74f8-7c41-be78-7982013f8675\horizai-buildcheck-14a2b-69cbc020f8bb46a4ab5745fdf347f862`

El `%TEMP%` expuesto al proceso estaba bloqueado por el sandbox; el destino alternativo está dentro del root local `.codex` habilitado para escritura, fuera de OneDrive/Dropbox y no es un montaje de red.

## copyExclusions

La copia refleja los archivos fuente modificados y untracked presentes en el worktree, y excluye:

- `.git`, `node_modules`, `.next`, `.netlify`;
- `artifacts`, `docs` y los directorios temporales previos `.tmp-12f12d-tests` y `.tmp-m39-tests`;
- `.env`, todos los `.env.*`, `.npmrc` local, ZIP, TGZ, TAR, 7z y RAR.

`docs` y `artifacts` no participan en la compilación de la app. Las pruebas enfocadas requeridas usan el código, migration y plantilla copiados. La copia no reutilizó ni archivó el `.git` original.

## secretScan

Antes de instalar: `.env.local` ausente; cero archivos `.env*`; cero directorios `node_modules`, `.next` o `.git`; cero archivos de paquete archivado. No se copiaron credenciales (0). El escaneo recursivo usó la función `scanTextForSecretPresence` del auditor del repositorio sobre 630 archivos de texto: 0 hallazgos.

Después del build se repitió el escaneo excluyendo dependencias y artefactos generados: 633 archivos de texto, 0 hallazgos, 0 archivos `.env*`. El wrapper `safe-secret-audit.mjs` no funciona sin `.git` porque consulta `git ls-files` y `git diff`; se mantuvo `.git` excluido y se ejecutó directamente su mismo detector de patrones sobre el árbol aislado. No se imprimieron valores de credenciales.

## sourceIntegrity

Los SHA-256 de origen y copia coincidieron antes de instalar y después del build:

| Archivo | SHA-256 |
| --- | --- |
| `supabase/migrations/20261022120000_scheduler_safety_repair_m40.sql` | `DD5A619BB50077CD71B05077B4E8DB53D74BB5F888CD209CF662816618508B5E` |
| `lib/agents/pipeline/scheduler/supervised-scheduler-orchestrator.ts` | `A2ABEF96F75868B8F842E163CBC68068E1EE03E7050A688605219DBD39DD59B3` |
| `scripts/supervised-scheduler-run.ts` | `A550C3DE1F874D913C26768E2155F5E2B0952B8E04165BF64927080680A691A1` |
| `package.json` | `C62D7CAEE9B7E865116F1BF86B5C720FD03CFAC8A04623F47B9C3EB20CC1E60C` |
| `package-lock.json` | `A294EAE731F6EB922C3E54C02A27961AE3EF67C63948D5FD92E470417B12D92F` |
| `app/contacto/page.tsx` | `6B0E623300294E7C3F14560D11AA154B1A07C52D49230F4946179D2D9771B952` |
| `next.config.ts` | `959F64EBA08E235776EC71C3A39522663D21E675D5E56ABCBB744162D911E528` |
| `ops/github-actions/horizai-supervised-scheduler.yml` | `20AF03B43D51681396A4AEBA1044B20939F1B5A548077EDD48D2CC55B7B664FB` |

## install

`npm ci --no-audit --no-fund` passed using the existing lockfile and installed 454 packages. The first sandboxed attempt could not resolve `registry.npmjs.org`; the authorized retry used separate temporary npm user/global config files with only the public registry and no credentials. No package versions or lockfile were changed. The temporary npm cache and configs were kept inside the isolated workspace.

## build and contactoPrerender

Environment: Windows Node `v22.14.0`, npm `10.9.2`, Next.js `16.3.8`, `CIRCLE_NODE_TOTAL=2`, telemetry disabled, `CI=true`; `NEXT_PUBLIC_SITE_URL` and private runtime credentials were absent. The canonical package command is `npm.cmd run build`, which runs `next build --webpack`.

The first isolated build attempt could not resolve `fonts.googleapis.com`. A second build with network access solely for the existing static Google Fonts imports passed:

- webpack compile: PASS;
- Next TypeScript phase: PASS;
- static page generation: 19/19 PASS;
- `/contacto`: PASS, listed as static prerendered;
- build exit code: 0.

The expected warning stated that `NEXT_PUBLIC_SITE_URL` was missing and indexing metadata was disabled; no production URL was invented. The generated `.next` directory stayed in the isolated workspace and was not copied to OneDrive.

## tests

Passed in the isolated workspace:

- `npm.cmd run migration40:lease:unit`
- `npm.cmd run scheduler:host:unit`
- `npm.cmd run scheduler:14a:unit`
- `npm.cmd run pipeline:scheduler:unit`
- `npm.cmd run lint`
- `npx.cmd tsc --noEmit`
- canonical Webpack build above
- isolated secret pattern scan: 0 findings

`git diff --check` passed in the original repo (exit 0). It is not available inside the isolated copy because `.git` was deliberately excluded. The source hashes establish that the tested copy matches the original for the listed gate files.

## classification and final14A2Status

- Classification: `WORKSPACE_FILESYSTEM_EPHEMERAL`.
- Source/app changes required by this diagnostic: 0. Only requested documentation/artifact files were added or updated in the original worktree.
- 14A.2b: PASS.
- 14A.2 implementation: PASS.
- Ready for 14A.3 remote M40: YES; M40 has **not** been applied remotely.
- Remote writes: 0; M40 remote apply: NO; scheduler activation: NO; GitHub workflow activation: NO; pipeline runs: 0; daily trigger consumption: 0; provider calls: 0; deploys: 0; cost: €0.

GitHub Actions on a hosted Linux runner does not execute inside the local OneDrive filesystem. This removes this specific local filesystem condition, but does not prove that a future production workflow will work.

## nextPhase

`14A3_REMOTE_M40` — remote M40 validation/application only under that phase's own authorization and gates. Do not activate the scheduler or GitHub workflow as part of 14A.2b.
