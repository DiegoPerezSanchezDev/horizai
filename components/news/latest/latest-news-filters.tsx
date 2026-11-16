import type { PublicArticleCategory } from "@/lib/public-content-model";

interface LatestNewsFiltersProps {
  categories: readonly PublicArticleCategory[];
  activeCategory: string | null;
  onSelect: (category: string | null) => void;
}

export function LatestNewsFilters({ categories, activeCategory, onSelect }: LatestNewsFiltersProps) {
  return (
    <div className="scroll-x flex min-w-0 gap-1.5 py-0.5" aria-label="Filtrar noticias por categoría">
      <button type="button" aria-pressed={activeCategory === null} onClick={() => onSelect(null)} className="chip chip-sm">Todas</button>
      {categories.map((category) => (
        <button key={category.slug} type="button" aria-pressed={activeCategory === category.slug} onClick={() => onSelect(category.slug)} className="chip chip-sm">
          {category.name}
        </button>
      ))}
    </div>
  );
}
