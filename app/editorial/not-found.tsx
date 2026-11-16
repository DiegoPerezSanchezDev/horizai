import Link from "next/link";

export default function EditorialNotFound() {
  return <main id="contenido" className="ed-main ed-empty"><h1>Revisión no disponible</h1><p>Este espacio solo contiene ejemplos locales durante el desarrollo.</p><Link className="ed-review-link" href="/editorial">Volver a la bandeja</Link></main>;
}
