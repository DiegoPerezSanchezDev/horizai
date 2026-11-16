import type { ReactNode } from "react";
import { requireEditorialOperator } from "@/lib/editorial-auth/server";
import { resolveEditorialDataMode } from "@/lib/editorial/data-mode";
import { isEditorialDecisionEnabled } from "@/lib/editorial/decision-policy";

export default async function EditorialWorkspaceLayout({ children }: { children: ReactNode }) {
  await requireEditorialOperator();
  const mode = resolveEditorialDataMode(process.env.NODE_ENV, process.env.EDITORIAL_LIVE_DATA_ENABLED);
  return <>
    <div className="ed-session-strip"><span>Sesión de operador{mode === "FIXTURE" ? " · Datos simulados" : mode === "LIVE_READ_ONLY" && process.env.NODE_ENV === "development" ? " · Lectura en vivo" : ""}</span><form action="/editorial/auth/logout" method="post"><button type="submit">Cerrar sesión</button></form></div>
    {mode !== "LIVE_DISABLED" && process.env.NODE_ENV === "development" ? <div className="ed-dev-note"><span className="ed-dev-label">{mode === "FIXTURE" ? "DEV · UI-06" : "DEV · UI-07"}</span><span>{mode === "FIXTURE" ? "Datos simulados · decisiones deshabilitadas" : isEditorialDecisionEnabled(process.env.EDITORIAL_DECISIONS_ENABLED, process.env.EDITORIAL_LIVE_DATA_ENABLED) ? "M32 en vivo · decisiones activas" : "M32 de solo lectura · decisiones desactivadas"}</span></div> : null}
    {children}
  </>;
}
