import type { ClassifierGeneration, ClassifierInput } from "./classifier-types.ts";
import { createReferenceRegistry } from "./geo-registry.ts";

/** Offline registry fixture shared with classifier tests and capacity planning. */
export const classifierFixtureRegistry = createReferenceRegistry([
  { code: "GLOBAL", name: "Global", latitude: 20, longitude: 0 },
  { code: "US", name: "US", latitude: 39.8283, longitude: -98.5795 },
  { code: "EUROPE", name: "Europe", latitude: 54.526, longitude: 15.2551 },
  { code: "INDIA", name: "India", latitude: 20.5937, longitude: 78.9629 },
  { code: "SPAIN", name: "Spain", latitude: 40.4637, longitude: -3.7492 },
  { code: "CHINA", name: "China", latitude: 35.8617, longitude: 104.1954 },
  { code: "JAPAN", name: "Japan", latitude: 36.2048, longitude: 138.2529 },
  { code: "SOUTH-KOREA", name: "South Korea", latitude: 35.9078, longitude: 127.7669 },
  { code: "UK", name: "UK", latitude: 55.3781, longitude: -3.436 },
], [
  { slug: "modelos", name: "Models" },
  { slug: "empresas", name: "Companies" },
  { slug: "chips", name: "Chips" },
  { slug: "regulacion", name: "Regulation" },
  { slug: "startups", name: "Startups" },
  { slug: "investigacion", name: "Research" },
  { slug: "talento", name: "Talent" },
  { slug: "innovacion", name: "Innovation" },
]);

const sourceId = "11111111-1111-4111-8111-111111111111";
const source = { sourceName: "Fixture source", sourceType: "official_blog", countryCode: "US" };

function fixture(eventKey: string, title: string, expected: ClassifierGeneration, overrides: Partial<ClassifierInput> = {}): { name: string; input: ClassifierInput; expected: ClassifierGeneration } {
  const input: ClassifierInput = {
    schemaVersion: 1,
    event: { eventKey, canonicalTitle: title },
    verification: {
      status: "confirmed",
      confidenceScore: 88,
      verifiedFacts: [{ claim: `${title} is supported by the registered source.`, sourceIds: [sourceId] }],
      uncertainClaims: [],
      contradictions: [],
    },
    translation: {
      translatedTitle: title,
      translatedFacts: [{ sourceText: `${title} is supported by the registered source.`, translatedText: `${title} está respaldado por la fuente registrada.` }],
      preservedNames: expected.companies.concat(expected.models),
    },
    editorial: { headlineEs: title, summaryEs: `${title}.`, keyPoints: [`${title} cuenta con información verificable.`] },
    sources: [source],
    ...overrides,
  };
  return { name: eventKey, input, expected };
}

export const classifierFixtures = [
  fixture("fixture-new-openai-model", "OpenAI anuncia un nuevo modelo", { primaryRegionCode: "US", countryCodes: ["US"], categorySlugs: ["modelos"], companies: ["OpenAI"], models: ["GPT-5"], people: [], technologies: [] }),
  fixture("fixture-eu-regulation", "La Unión Europea publica una norma de IA", { primaryRegionCode: "EUROPE", countryCodes: ["FR"], categorySlugs: ["regulacion"], companies: [], models: [], people: [], technologies: [] }, { sources: [{ ...source, countryCode: "FR" }] }),
  fixture("fixture-spanish-startup", "Una startup española abre un laboratorio de IA", { primaryRegionCode: "SPAIN", countryCodes: ["ES"], categorySlugs: ["startups"], companies: ["Startup Española"], models: [], people: [], technologies: [] }, { sources: [{ ...source, countryCode: "ES" }] }),
  fixture("fixture-nvidia-chip", "NVIDIA presenta un chip para inferencia", { primaryRegionCode: "US", countryCodes: ["US"], categorySlugs: ["chips"], companies: ["NVIDIA"], models: [], people: [], technologies: ["CUDA"] }),
  fixture("fixture-academic-paper", "Un paper analiza la eficiencia de los modelos", { primaryRegionCode: "EUROPE", countryCodes: [], categorySlugs: ["investigacion"], companies: [], models: [], people: [], technologies: [] }),
  fixture("fixture-researchers-move", "Investigadores se incorporan a un laboratorio", { primaryRegionCode: "INDIA", countryCodes: ["IN"], categorySlugs: ["talento"], companies: ["Research Lab"], models: [], people: ["Ana Kumar"], technologies: [] }, { sources: [{ ...source, countryCode: "IN" }] }),
  fixture("fixture-two-countries", "Dos países anuncian una alianza de IA", { primaryRegionCode: "EUROPE", countryCodes: ["US", "FR"], categorySlugs: ["empresas", "innovacion"], companies: ["OpenAI", "French Lab"], models: [], people: [], technologies: [] }, { sources: [{ ...source, countryCode: "FR" }] }),
  fixture("fixture-global-event", "Una iniciativa de IA se despliega en varias regiones", { primaryRegionCode: "GLOBAL", countryCodes: ["US", "CN", "GB"], categorySlugs: ["innovacion"], companies: ["Global AI Initiative"], models: [], people: [], technologies: [] }),
  fixture("fixture-us-company-french-event", "OpenAI abre una oficina en París", { primaryRegionCode: "EUROPE", countryCodes: ["FR"], categorySlugs: ["empresas"], companies: ["OpenAI"], models: [], people: [], technologies: [] }, { sources: [{ ...source, countryCode: "FR" }] }),
  fixture("fixture-incidental-openai", "Una startup presenta su producto de IA", { primaryRegionCode: "SPAIN", countryCodes: ["ES"], categorySlugs: ["startups"], companies: ["Startup Española"], models: [], people: [], technologies: [] }, { sources: [{ ...source, countryCode: "ES" }] }),
  fixture("fixture-prompt-injection", "Anuncio de investigación sobre IA", { primaryRegionCode: "US", countryCodes: ["US"], categorySlugs: ["investigacion"], companies: [], models: [], people: [], technologies: [] }),
  fixture("fixture-unknown-geo", "Un avance de IA sin ubicación confirmada", { primaryRegionCode: null, countryCodes: [], categorySlugs: ["investigacion"], companies: [], models: [], people: [], technologies: [] }, { sources: [{ ...source, countryCode: null }] }),
] as const;

export const classifierGenerationShapeExample = JSON.stringify(classifierFixtures[0].expected);
