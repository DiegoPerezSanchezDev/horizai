# Integración de main — 16 de noviembre de 2026

## Objetivo

Versionar el código mantenible y sus pruebas, conservar el trabajo previo y preparar el piloto web con el subdominio de Netlify. No desplegar, modificar datos remotos ni activar automatizaciones.

## Alcance

- Web pública, contenido publicado, mapa y metadata.
- Autenticación editorial, revisión humana y pipeline conservados como código. Las capacidades editoriales live, decisiones y retiradas quedan desactivadas en la configuración inicial de Netlify.
- Migraciones conservadas sin aplicarlas remotamente. Los archivos de migración deben verificarse contra el historial del entorno antes de su aplicación.
- Dependencias corregidas mediante actualizaciones compatibles, incluido Next.js 16.4.6.
- Directorio de publicación explícito `.next`; nunca la raíz del repositorio.
- Producción usa `NEXT_PUBLIC_SITE_URL` o, en su ausencia, `URL` de Netlify. El contexto de deploy se fija durante el build para que un preview siga siendo no indexable durante SSR.

## Preservación

El historial original contiene checkpoints y borradores. Antes de preparar el historial publicable se ha creado una copia local de los archivos y un bundle de las ramas. El remoto estaba vacío: el nuevo main empieza con un snapshot revisado sin esos artefactos en sus ancestros. No se publica el historial interno anterior.

Los artefactos, cachés, configuración de sesiones y archivos `.env` reales quedan fuera del repositorio. No se borran del disco para obtener un estado limpio. Las instrucciones y skills del proyecto se conservan.

## Verificación reproducible

```sh
npm ci
npm run test:release
npm run lint
npm run build
node scripts/safe-secret-audit.mjs
npm audit
```

La suite de release incluye contratos, etapas editoriales, presupuestos, reservas, scheduler con mocks, publisher, aislamiento público/privado, autenticación y URL/SEO. Las regresiones que requieren artefactos privados se mantienen disponibles como comandos históricos y se excluyen explícitamente del runner. Un PASS offline no acredita acceso remoto ni autorización de publicación.

Se han sustituido las dependencias de checkpoints privados en las pruebas de critic, checkpoints durables y recuperación de capacidad por fixtures sintéticos. Cinco comandos siguen ligados a evidencias históricas concretas: `cloudflare:quality-benchmark:unit`, `pipeline:factual-remediation:final-resume:unit`, `pipeline:factual-remediation:continuation:unit`, `human-review:revision-binding:unit` y `supervised-snapshot:executor:unit`. Se conservan fuera de la batería reproducible y no se presentan como verificados en un checkout limpio.

### Resultados de la integración

La verificación se ha repetido en un checkout separado, instalado con `npm ci`, sin `.env.local` ni checkpoints privados:

- 83/83 suites de release pasan.
- Lint sin errores ni avisos; build de producción con Next.js 16.4.6 completado.
- Auditoría de secretos sin hallazgos; archivos de entorno reales ignorados.
- Instalación y auditoría de dependencias sin vulnerabilidades conocidas; auditoría adicional de producción con resultado cero.
- 16 comprobaciones HTTP locales pasan: seis rutas públicas y cabeceras de seguridad, redirección editorial 303 y no-store, login noindex, rechazo de API privada sin configuración, robots sin indexación, cuatro URLs internas con 404 y ambos módulos MapLibre con 200.

El aviso de URL canónica ausente en este build local es esperado: sin host de producción configurado se desactiva la indexación. Estas comprobaciones no validan la interacción visual, la disponibilidad de datos reales ni el despliegue de Netlify. No se ha realizado un despliegue explícito.

## Antes del piloto público

1. Configurar solo las credenciales públicas de Supabase y el host de producción de Netlify; verificar RLS y que solo se leen artículos publicados.
2. Verificar en un draft limpio HTTPS, CSP, rutas, worker/mapa, cookies, errores, dispositivos y temas. Comprobar que código fuente, documentos, borradores y archivos de entorno no se sirven como assets.
3. Revisar el incidente de preview registrado previamente y el estado actual de los drafts antes de cambiar su visibilidad. La integración Git no modifica esos drafts.
4. Confirmar un contacto operativo y completar la revisión humana de privacidad y términos. El código no acredita aprobación legal.
5. Resolver almacenamiento persistente antes de activar el panel live o decisiones en serverless; validar autenticación y migraciones en un entorno de ensayo.

No se compra un dominio, no se cambian DNS, no se envían mensajes y no se aplica ninguna migración durante esta integración.
