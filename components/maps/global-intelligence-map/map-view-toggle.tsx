import type { MapViewMode } from "./map-types";

interface MapViewToggleProps {
  activeView: MapViewMode;
  onChange: (view: MapViewMode) => void;
}

function NodesIcon() {
  return (
    <svg aria-hidden="true" className="size-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="4" cy="11" r="1.8" />
      <circle cx="12" cy="4" r="1.8" />
      <circle cx="12.5" cy="12" r="1.5" />
      <path d="M5.4 9.8 10.6 5.3M5.8 11.2l5.2.6" />
    </svg>
  );
}

function HeatIcon() {
  return (
    <svg aria-hidden="true" className="size-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="2" />
      <circle cx="8" cy="8" r="4.6" opacity="0.6" />
      <circle cx="8" cy="8" r="7" opacity="0.3" />
    </svg>
  );
}

export function MapViewToggle({ activeView, onChange }: MapViewToggleProps) {
  return (
    <div className="view-toggle" data-active={activeView} role="group" aria-label="Cambiar vista del mapa">
      {([
        ["nodes", "Nodos", <NodesIcon key="nodes" />],
        ["heat", "Calor", <HeatIcon key="heat" />],
      ] as const).map(([view, label, icon]) => (
        <button
          key={view}
          type="button"
          aria-pressed={activeView === view}
          onClick={() => onChange(view)}
          className="view-toggle-button"
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  );
}
