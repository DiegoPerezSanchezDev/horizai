import Link from "next/link";
import { getEditorialDataMode } from "@/lib/editorial/data-mode";
import { getRecentPublishedArticles } from "@/lib/public-content";
import { formatPublishedDate } from "@/lib/public-content-model";
import { WITHDRAWAL_REASONS, isWithdrawalEnabled } from "@/lib/editorial/withdrawal-policy";

export const dynamic = "force-dynamic";

const STATE_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  withdrawn: { tone: "ok", text: "Noticia retirada. Ya no aparece en la web pública." },
  already_withdrawn: { tone: "ok", text: "Esa noticia ya estaba retirada; no se ha cambiado nada." },
  restored: { tone: "ok", text: "Noticia restaurada." },
  disabled: { tone: "warn", text: "La retirada está desactivada en este entorno." },
  not_found: { tone: "warn", text: "No existe ninguna noticia con ese enlace." },
  not_published: { tone: "warn", text: "Esa noticia no está publicada, así que no se puede retirar." },
  not_withdrawn: { tone: "warn", text: "Esa noticia no consta como retirada desde este panel; no se restaura." },
  invalid: { tone: "warn", text: "Solicitud no válida." },
  invalid_slug: { tone: "warn", text: "El enlace o identificador de la noticia no es válido." },
  invalid_reason: { tone: "warn", text: "Elige un motivo." },
  invalid_note: { tone: "warn", text: "La nota interna es obligatoria (entre 10 y 1000 caracteres, sin caracteres de control)." },
  not_confirmed: { tone: "warn", text: "Marca la casilla de confirmación." },
  error: { tone: "warn", text: "No se pudo completar la acción. No se ha cambiado nada que podamos garantizar; revisa el estado antes de reintentar." },
};

function ReasonSelect() {
  return (
    <select name="reason" required defaultValue="">
      <option value="" disabled>Motivo…</option>
      {Object.entries(WITHDRAWAL_REASONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  );
}

export default async function PublishedArticles({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await getEditorialDataMode();
  const enabled = isWithdrawalEnabled(process.env.EDITORIAL_WITHDRAWAL_ENABLED);
  const stateParam = (await searchParams).state;
  const state = typeof stateParam === "string" ? STATE_MESSAGES[stateParam] : undefined;
  const published = await getRecentPublishedArticles();

  return (
    <main id="contenido" className="ed-main ed-wd">
      <div className="ed-intro">
        <p className="ed-eyebrow">Mesa editorial</p>
        <h1>Noticias publicadas</h1>
        <p className="ed-intro-copy">Retira una noticia de la web pública. Queda registrada con motivo, fecha y operador, y se puede restaurar.</p>
      </div>
      <p><Link className="ed-review-link" href="/editorial"><span aria-hidden="true">←</span> Volver a la bandeja</Link></p>

      {!enabled ? <p className="ed-wd-note ed-wd-warn" role="status">La retirada está desactivada en este entorno. Se activa con una variable de entorno explícita; hoy esta pantalla solo muestra el listado.</p> : null}
      {state ? <p className={`ed-wd-note ed-wd-${state.tone}`} role="status">{state.text}</p> : null}

      <section aria-labelledby="wd-recent"><h2 id="wd-recent">Últimos 30 días</h2>
        {published.status === "error" ? <p className="ed-secondary">No se pudo leer el listado público. Puedes retirar por enlace más abajo.</p>
          : published.data.length === 0 ? <p className="ed-secondary">No hay noticias publicadas en los últimos 30 días.</p>
          : <ol className="ed-wd-list">{published.data.map((article) => (
            <li key={article.slug} className="ed-wd-item">
              <div><strong>{article.headline}</strong>
                <span className="ed-secondary"> · {formatPublishedDate(article.publishedAt)} · <Link href={`/noticias/${article.slug}`} target="_blank" rel="noopener noreferrer">ver pública</Link></span></div>
              <details><summary>Retirar…</summary>
                <form method="post" action="/editorial/publicadas/withdraw" className="ed-wd-form">
                  <input type="hidden" name="action" value="withdraw" />
                  <input type="hidden" name="slug" value={article.slug} />
                  <ReasonSelect />
                  <textarea name="note" required minLength={10} maxLength={1000} rows={3} placeholder="Nota interna obligatoria: qué se reclama y quién." />
                  <label><input type="checkbox" name="confirm" value="yes" required /> Confirmo que quiero retirar esta noticia</label>
                  <button type="submit" disabled={!enabled}>Retirar noticia</button>
                </form>
              </details>
            </li>))}</ol>}
      </section>

      <section aria-labelledby="wd-link"><h2 id="wd-link">Retirar por enlace</h2>
        <form method="post" action="/editorial/publicadas/withdraw" className="ed-wd-form">
          <input type="hidden" name="action" value="withdraw" />
          <input type="text" name="slug" required placeholder="https://…/noticias/identificador-de-la-noticia" />
          <ReasonSelect />
          <textarea name="note" required minLength={10} maxLength={1000} rows={3} placeholder="Nota interna obligatoria." />
          <label><input type="checkbox" name="confirm" value="yes" required /> Confirmo la retirada</label>
          <button type="submit" disabled={!enabled}>Retirar noticia</button>
        </form>
      </section>

      <section aria-labelledby="wd-restore"><h2 id="wd-restore">Restaurar una retirada</h2>
        <p className="ed-secondary">Solo funciona con noticias retiradas desde este panel.</p>
        <form method="post" action="/editorial/publicadas/withdraw" className="ed-wd-form">
          <input type="hidden" name="action" value="restore" />
          <input type="text" name="slug" required placeholder="Enlace o identificador de la noticia retirada" />
          <label><input type="checkbox" name="confirm" value="yes" required /> Confirmo la restauración</label>
          <button type="submit" disabled={!enabled}>Restaurar noticia</button>
        </form>
      </section>
    </main>
  );
}
