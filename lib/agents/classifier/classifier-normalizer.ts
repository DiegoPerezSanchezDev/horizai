type EntityGroup = "companies" | "models" | "people" | "technologies";

const exactAliases: Record<string, string> = {
  "meta platforms": "Meta",
  "meta platforms, inc.": "Meta",
};

function normalizedKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function normalizeEntityName(value: string): string {
  return exactAliases[normalizedKey(value)] ?? value.trim();
}

export function normalizeEntityGroups(groups: Record<EntityGroup, string[]>): Record<EntityGroup, string[]> {
  return Object.fromEntries(Object.entries(groups).map(([group, values]) => {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = normalizeEntityName(value);
      const key = normalizedKey(normalized);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(normalized);
      }
    }
    return [group, result];
  })) as Record<EntityGroup, string[]>;
}
