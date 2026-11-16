interface RegionOption {
  code: string;
  name: string;
}

interface FeaturedStoriesFiltersProps {
  activeRegion: string | null;
  regions: readonly RegionOption[];
  onSelect: (regionCode: string | null) => void;
}

export function FeaturedStoriesFilters({ activeRegion, regions, onSelect }: FeaturedStoriesFiltersProps) {
  if (regions.length < 2) return null;

  return (
    <div className="scroll-x -mx-4 px-4 py-0.5 sm:mx-0 sm:px-0" aria-label="Filtrar historias por región">
      <div className="flex w-max gap-2 pr-4 sm:pr-0">
        <button type="button" aria-pressed={activeRegion === null} onClick={() => onSelect(null)} className="chip">
          Todas las regiones
        </button>
        {regions.map((region) => (
          <button key={region.code} type="button" aria-pressed={activeRegion === region.code} onClick={() => onSelect(region.code)} className="chip">
            {region.name}
          </button>
        ))}
      </div>
    </div>
  );
}
