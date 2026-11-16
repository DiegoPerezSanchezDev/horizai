"use client";

export default function EditorialError({ reset }: { reset: () => void }) {
  return <main id="contenido" className="ed-main ed-empty"><h1>No se pudo abrir la revisión</h1><p>Inténtalo de nuevo. No se ha ejecutado ninguna decisión.</p><button type="button" className="ed-action ed-action-hold" onClick={reset}>Reintentar</button></main>;
}
