# HorizAI

Base técnica y visual de HorizAI con hero principal y mapa global interactivo.

## Stack

- Next.js con App Router
- TypeScript en modo estricto
- Tailwind CSS 4
- MapLibre GL JS
- ESLint
- Despliegue compatible con Netlify

La aplicación mantiene el soporte para tema claro/oscuro mediante las variables CSS globales y la variante `dark` de Tailwind. La web pública lee únicamente artículos publicados en Supabase; distingue contenido vacío, errores de lectura y contenido disponible. El panel editorial requiere un operador autenticado y sus acciones permanecen desactivadas por defecto.

## Requisitos

- Node.js 22 o superior
- npm 10 o superior

## Desarrollo local

```bash
npm install
Copy-Item .env.example .env.local
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000).

Comandos disponibles:

```bash
npm run dev       # servidor de desarrollo
npm run lint      # comprobación de ESLint
npm run build     # compilación de producción
npm run start     # servidor de producción, después de build
```

## Variables de entorno

Copia `.env.example` a `.env.local` y completa únicamente las variables que se necesiten. Los archivos `.env*` están ignorados por Git; `.env.example` sí se versiona como plantilla.

`NEXT_PUBLIC_MAP_STYLE_URL` permite cambiar el proveedor o estilo vectorial sin modificar los componentes. En desarrollo se usa por defecto el estilo oscuro de OpenFreeMap, que no requiere API key. La atribución de OpenFreeMap, OpenMapTiles y OpenStreetMap se muestra dentro del mapa.

Los comandos `npm run dev` y `npm run build` copian automáticamente a `public/maplibre/` los dos módulos de worker que MapLibre 6 necesita con Next.js y Turbopack.

## Despliegue en Netlify

1. Conecta el repositorio en Netlify.
2. Usa Node.js 22 (también está indicado en `netlify.toml`).
3. Configura las variables de entorno del panel de Netlify según `.env.example`.
4. Netlify ejecutará `npm run build`, publicará `.next` y detectará el adaptador de Next.js.
5. El piloto utiliza el subdominio `*.netlify.app` asignado por Netlify. En contexto `production`, su variable `URL` se usa como origen canónico cuando `NEXT_PUBLIC_SITE_URL` está vacío. Un valor explícito de `NEXT_PUBLIC_SITE_URL` tiene prioridad para un futuro dominio propio. Los previews permanecen fuera de la indexación.
6. Mantén desactivados los datos editoriales en vivo, las decisiones y las retiradas hasta disponer de almacenamiento persistente y validar sus requisitos de operación. No configures credenciales de proveedores ni el secreto del scheduler para un despliegue exclusivamente web.

Para crear un draft con Netlify CLI, usa un build del adaptador y verifica su directorio publicado. No subas la raíz del repositorio:

```bash
netlify deploy --build --dir=.next
```

## Estructura

```text
app/                 # rutas y layout del App Router
components/          # componentes reutilizables
  hero/
  maps/
  news/
  ui/
lib/                 # integraciones y utilidades
  maps/
  supabase/
types/               # tipos compartidos
data/                # datos estáticos o fixtures
scripts/             # automatizaciones y métricas
  agents/
  metrics/
docs/                # documentación del proyecto
```

## Verificación y datos locales

`npm ci`, `npm run test:release`, `npm run lint` y `npm run build` comprueban la entrega. La suite de release ejecuta pruebas offline; cinco regresiones históricas requieren evidencias privadas locales y se enumeran por separado en el runner. No aplica migraciones, ejecuta proveedores ni activa el scheduler.

`artifacts/` contiene checkpoints, borradores, evidencias y resultados locales: se conserva fuera de Git. Los comandos operativos y algunas regresiones históricas pueden requerir esos archivos; no forman parte de la comprobación de un checkout limpio. Las migraciones de `supabase/migrations/` se versionan como código, pero requieren una validación y una aplicación explícitas en el entorno correspondiente.

La integración en `main` no sustituye la validación del hosting, el contacto operativo ni la revisión humana de los textos legales. Consulta `docs/release-main-2026-11-16.md`.
