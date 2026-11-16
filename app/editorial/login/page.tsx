import { getEditorialAuthConfiguration, getEditorialAuthOrigin } from "@/lib/editorial-auth/config";
import { headers } from "next/headers";

const notices: Record<string, string> = {
  expired: "Tu sesión o código ha caducado. Solicita un nuevo código para continuar.",
  unauthorized: "Esta cuenta no tiene acceso editorial. Utiliza una cuenta de operador autorizada.",
  unavailable: "El acceso de operador no está disponible. Comprueba la configuración de autenticación antes de continuar.",
  "invalid-email": "Introduce una dirección de correo válida.",
  "invalid-code": "El código no es válido o ha caducado. Compruébalo o solicita uno nuevo.",
  invalid: "No se pudo procesar el formulario. Vuelve a intentarlo.",
  "signed-out": "Has cerrado la sesión en este dispositivo.",
};

export default async function EditorialLogin({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = (await searchParams).state;
  const status = typeof state === "string" ? state : "";
  const showCode = status === "code" || status === "invalid-code";
  // Read-only request API keeps this page dynamic; no cookies or identity in its metadata.
  const host = (await headers()).get("host") ?? "";
  const configured = !!getEditorialAuthConfiguration() && !!getEditorialAuthOrigin(`http://${host}/`);
  const message = !configured ? notices.unavailable : Object.hasOwn(notices, status) ? notices[status] : undefined;
  return <main id="contenido" className="ed-main ed-auth-main">
    <section className="ed-auth-panel" aria-labelledby="operator-title">
      <p className="ed-eyebrow">HorizAI Editorial</p>
      <h1 id="operator-title">Acceso de operador</h1>
      <p className="ed-auth-intro">Un espacio privado para revisar historias con contexto y criterio editorial.</p>
      {message ? <p className={`ed-auth-notice ${status === "unauthorized" ? "ed-auth-denied" : ""}`} role="status">{message}</p> : null}
      {showCode && configured ? <>
        <p className="ed-auth-notice" role="status">Si el correo corresponde a un operador con acceso, recibirás un código. Introdúcelo aquí; nunca compartas el código.</p>
        <form action="/editorial/auth/verify" method="post" className="ed-auth-form">
          <label htmlFor="operator-code">Código de acceso</label>
          <input id="operator-code" name="token" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" minLength={6} maxLength={10} required aria-describedby="code-help" autoFocus />
          <p id="code-help" className="ed-secondary">Solicita otro código si pasan diez minutos. Si no llega ningún correo, puede haberse alcanzado el límite de envíos del proveedor (unos 2 por hora): espera y vuelve a intentarlo. Usa el código numérico; el enlace del correo no inicia sesión aquí.</p>
          <button type="submit" className="ed-action ed-action-publish">Verificar y continuar</button>
        </form>
        <a className="ed-back" href="/editorial/login">Usar otro correo o solicitar un nuevo código</a>
      </> : <form action="/editorial/auth/request" method="post" className="ed-auth-form">
        <label htmlFor="operator-email">Correo electrónico</label>
        <input id="operator-email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required disabled={!configured} aria-describedby="email-help" />
        <p id="email-help" className="ed-secondary">Solo cuentas de operador autorizadas. No se crean cuentas desde esta pantalla.</p>
        <button type="submit" className="ed-action ed-action-publish" disabled={!configured}>Continuar</button>
      </form>}
      {status === "unauthorized" ? <form action="/editorial/auth/logout" method="post"><button type="submit" className="ed-back">Cerrar la sesión actual</button></form> : null}
      <p className="ed-auth-footnote">La sesión se verifica en el servidor. Las decisiones editoriales y las notificaciones siguen deshabilitadas.</p>
    </section>
  </main>;
}
