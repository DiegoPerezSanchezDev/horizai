# Plan de rollback — HorizAI

Este plan es para un deploy futuro. Ningún deploy o rollback se ejecutó en LR-01.

## Cuándo revertir

Solicitar rollback del frontend si el deploy publicado causa errores SSR sostenidos, home o artículos inaccesibles, 5xx relevantes, filtración de secretos, CSP que bloquea hidratación/mapa/lecturas públicas, canonical/robots que indexan el host incorrecto, mapa inutilizable o un bloqueo grave de lectura/accesibilidad. Definir umbral operativo y responsable durante el preview.

## Volver al último frontend conocido como bueno

1. Identificar el último deploy de Netlify marcado como producción correcta; anotar su ID/commit, hora y entorno asociado.
2. Comparar el deploy nuevo, variable de URL canónica, environment values no secretas (solo presencia/nombres) y cambios de config.
3. Usar el mecanismo de Netlify para volver a publicar el deploy previo aprobado. Verificar el dominio público, home/artículo, HTTPS, cabeceras, sitemap/robots y mapa después del rollback.
4. Si el origen es solo CSP o metadata/configuración, primero aislar el cambio de frontend que causó el problema; no deshabilitar globalmente medidas de seguridad para restaurar una función sin revisar.
5. Guardar logs e IDs necesarios para análisis sin copiar tokens, cookies, claves ni contenido privado a artifacts públicos.

## Qué no revertir automáticamente

- No hacer `git reset --hard` ni descartar el worktree compartido. Restaurar un deploy no implica borrar el trabajo local.
- No revertir migraciones aplicadas como rollback habitual. Una migración inmutable requiere plan correctivo nuevo, revisión, backup y aprobación independiente; no ejecutar DDL durante un rollback de frontend.
- No relanzar, cancelar ni “reparar” pipeline, scheduler, intentos, revisiones o artículos desde la acción de volver atrás el frontend. El pipeline tiene ciclo supervisado aparte.
- No modificar DNS para compensar un incidente de aplicación salvo plan y aprobación del responsable del dominio. Primero preservar host/certificado y diagnóstico.
- No rotar credenciales automáticamente por un fallo de build. Si hay exposición, activar el proceso de respuesta y rotación aprobado; nunca registrar el valor afectado.
- No volver a un build que lleve `NEXT_PUBLIC_SITE_URL` de preview ni publicar un build que mantenga `noindex`/`Disallow: /` cuando se espera tráfico indexable.

## Verificación tras rollback

Confirmar que Netlify sirve la build conocida, que el host canónico sigue seleccionado, HTTPS y redirect siguen correctos, CSP/HSTS son intencionales, no hay errores del cliente, y las lecturas públicas/worker/mapa responden. Mantener monitoreo reforzado y documentar causa, impacto y commit de corrección separado antes de volver a desplegar.
