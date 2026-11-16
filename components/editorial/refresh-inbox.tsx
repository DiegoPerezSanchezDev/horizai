"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function RefreshInboxButton() {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  return <button className="ed-refresh" type="button" onClick={() => startTransition(() => router.refresh())} disabled={refreshing}>
    {refreshing ? "Actualizando…" : "Actualizar"}
  </button>;
}
