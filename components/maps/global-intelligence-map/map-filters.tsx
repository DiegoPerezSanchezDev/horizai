import type { ReactNode } from "react";

import type { PublicArticleCategory } from "@/lib/public-content-model";
import type { GlobalMapFilters, MapTimeRange } from "./map-types";

interface RegionOption { code: string; name: string }
interface MapFiltersProps {
  filters: GlobalMapFilters;
  regions: readonly RegionOption[];
  categories: readonly PublicArticleCategory[];
  onChange: (filters: Partial<GlobalMapFilters>) => void;
}

const timeRanges: readonly { id: MapTimeRange; label: string }[] = [
  { id: "24h", label: "24 h" },
  { id: "7d", label: "7 días" },
  { id: "30d", label: "30 días" },
];

function FilterButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className="chip chip-sm">{children}</button>;
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="chip-label hidden w-14 sm:block">{label}</span>
      <div className="scroll-x -mx-1 flex min-w-0 flex-1 gap-1.5 px-1 py-0.5">{children}</div>
    </div>
  );
}

export function MapFilters({ filters, regions, categories, onChange }: MapFiltersProps) {
  return (
    <div className="glass-panel flex flex-col gap-2.5 rounded-panel px-3 py-3 sm:px-4 lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:gap-x-6 lg:gap-y-2.5" aria-label="Filtros del mapa">
      <FilterGroup label="Periodo">
        {timeRanges.map((range) => <FilterButton key={range.id} active={filters.timeRange === range.id} onClick={() => onChange({ timeRange: range.id })}>{range.label}</FilterButton>)}
      </FilterGroup>
      {regions.length > 0 ? (
        <FilterGroup label="Región">
          <FilterButton active={filters.region === null} onClick={() => onChange({ region: null })}>Todo el mundo</FilterButton>
          {regions.map((region) => <FilterButton key={region.code} active={filters.region === region.code} onClick={() => onChange({ region: region.code })}>{region.name}</FilterButton>)}
        </FilterGroup>
      ) : null}
      {categories.length > 0 ? (
        <div className="lg:col-span-2">
          <FilterGroup label="Tema">
            <FilterButton active={filters.category === null} onClick={() => onChange({ category: null })}>Todos</FilterButton>
            {categories.map((category) => <FilterButton key={category.slug} active={filters.category === category.slug} onClick={() => onChange({ category: category.slug })}>{category.name}</FilterButton>)}
          </FilterGroup>
        </div>
      ) : null}
    </div>
  );
}
