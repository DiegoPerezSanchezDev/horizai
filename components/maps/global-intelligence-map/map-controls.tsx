interface MapControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export function MapControls({ onZoomIn, onZoomOut, onReset }: MapControlsProps) {
  return (
    <div className="map-controls">
      <button type="button" className="map-control-button" onClick={onZoomIn} aria-label="Acercar mapa" title="Acercar">
        <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4"><path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      <button type="button" className="map-control-button" onClick={onZoomOut} aria-label="Alejar mapa" title="Alejar">
        <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4"><path d="M4 10h12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      <button type="button" className="map-control-button" onClick={onReset} aria-label="Centrar mapa" title="Centrar">
        <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4"><circle cx="10" cy="10" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
