function Metric({ value, label, note }: { value: number; label: string; note: string }) {
  return (
    <div className="hero-metric">
      <dt className="hero-metric-label">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="hero-metric-value">{value}</span>
        <span className="hero-metric-delta">{note}</span>
      </dd>
    </div>
  );
}

export function HeroMetrics({ storyCount, regionCount }: { storyCount: number; regionCount: number }) {
  return (
    <dl className="hero-metrics" aria-label="Resumen del briefing de las &uacute;ltimas 72 horas">
      <Metric value={storyCount} label="Noticias recientes" note="&uacute;ltimas 72 h" />
      <Metric value={regionCount} label="Regiones representadas" note="en el briefing" />
    </dl>
  );
}
