import type { PublicArticle, PublicArticleSummary } from "../lib/public-content-model.ts";

const QA_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 1380">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071629"/><stop offset=".55" stop-color="#10436c"/><stop offset="1" stop-color="#6a3f77"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="#7bdcff" stop-opacity=".85"/><stop offset="1" stop-color="#7bdcff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="960" height="1380" fill="url(#sky)"/>
  <circle cx="692" cy="470" r="340" fill="url(#glow)"/>
  <path d="M0 1010 230 790l150 116 204-288 376 420v342H0Z" fill="#05101f" fill-opacity=".7"/>
  <g fill="none" stroke="#d6f4ff" stroke-opacity=".7" stroke-width="4">
    <path d="m170 420 260-130 193 176 170-124"/><circle cx="170" cy="420" r="12" fill="#d6f4ff"/><circle cx="430" cy="290" r="12" fill="#d6f4ff"/><circle cx="623" cy="466" r="12" fill="#d6f4ff"/><circle cx="793" cy="342" r="12" fill="#d6f4ff"/>
    <path d="M92 650h780M130 690h330" stroke-opacity=".25"/>
  </g>
  <text x="88" y="1120" fill="#bcecff" font-family="Arial,sans-serif" font-size="24" letter-spacing="7">HORIZAI · SINTÉTICO</text>
  <text x="88" y="1200" fill="#fff" font-family="Arial,sans-serif" font-size="52" font-weight="700">Visual QA</text>
</svg>`;

const QA_COVER_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(QA_COVER_SVG)}`;
const QA_DATE = "2026-09-27T09:00:00.000Z";
const BASE_ENTITIES = [{ type: "organization", name: "Aurora Circuit Lab", countryCode: null }];

function qaSummary(overrides: Partial<PublicArticleSummary> & Pick<PublicArticleSummary, "slug" | "headline">): PublicArticleSummary {
  return {
    slug: overrides.slug,
    headline: overrides.headline,
    summary: overrides.summary ?? null,
    imageUrl: overrides.imageUrl ?? null,
    imageAlt: overrides.imageAlt ?? null,
    publishedAt: overrides.publishedAt ?? QA_DATE,
    regionCode: overrides.regionCode ?? null,
    regionName: overrides.regionName ?? null,
    latitude: overrides.latitude ?? null,
    longitude: overrides.longitude ?? null,
    categories: overrides.categories ?? [],
    sources: overrides.sources ?? [],
    entities: overrides.entities ?? [],
  };
}

const lead = qaSummary({
  slug: "qa-aurora-global-model",
  headline: "Un laboratorio ficticio presenta un modelo abierto que coordina observatorios de IA en tres continentes",
  summary: "En este escenario de prueba, Aurora Circuit Lab publica una arquitectura imaginaria para comparar señales de investigación, cómputo y adopción regional. La ficha es completamente sintética y sirve para revisar titulares largos, resumen editorial, fuentes, contexto y composición de imagen.",
  imageUrl: QA_COVER_URL,
  imageAlt: "Ilustración sintética de nodos conectados sobre un horizonte azul oscuro, creada para la revisión local de HorizAI.",
  publishedAt: QA_DATE,
  regionCode: "NA",
  regionName: "América del Norte",
  latitude: 37.7749,
  longitude: -122.4194,
  categories: [{ slug: "investigacion", name: "Investigación" }, { slug: "modelos", name: "Modelos" }],
  sources: [
    { name: "Cuaderno de prueba de Aurora", url: "https://aurora.example.invalid/research-note" },
    { name: "Archivo sintético de metodología", url: "https://horizai.example.invalid/qa-method" },
    { name: "Ficha de datos local", url: "https://horizai.example.invalid/qa-data" },
  ],
  entities: BASE_ENTITIES,
});

const longBody = [
  "## Una prueba editorial, no una noticia real",
  "Aurora Circuit Lab y todos los acontecimientos descritos en esta ficha son inventados para la revisión visual local. El texto permite comprobar la jerarquía del titular, la lectura sostenida, los enlaces y la presentación de fuentes sin reutilizar artículos protegidos ni enviar contenido a servicios externos.",
  "## Cómo se compone el escenario",
  "La historia imagina tres equipos de investigación que publican observaciones con nombres, fechas y ubicaciones deliberadamente variadas. La interfaz debe conservar la procedencia de cada dato y distinguir lo que está disponible de lo que falta. El mapa usa únicamente las coordenadas que aparecen en estas fichas de ensayo.",
  "En la primera región, el equipo ficticio mantiene un catálogo abierto de experimentos reproducibles. Cada nota indica qué se midió, con qué configuración y cuáles son las limitaciones conocidas. Esa estructura sirve para comprobar que los párrafos largos mantienen una anchura cómoda y que las etiquetas secundarias no compiten con el texto principal.",
  "En Europa, dos publicaciones comparten una ubicación exacta. El agrupamiento debe mantener ambas historias disponibles en el panel y evitar que los marcadores se dibujen uno encima del otro como si fueran dos lugares distintos. Al seleccionar la ubicación, el contexto debe mostrar el número correcto de publicaciones y conservar enlaces internos válidos.",
  "En Asia, una nota breve ofrece el caso opuesto: un titular corto, un resumen de una frase y una categoría distinta. La ficha también incluye una publicación sin categoría, región o coordenadas. El resultado esperado es una tarjeta legible con metadatos opcionales omitidos y una historia que no aparece en el mapa.",
  "### Límites del conjunto de ensayo",
  "Este conjunto no contiene afirmaciones sobre empresas, productos o políticas reales. Los dominios de fuentes usan el sufijo reservado `.invalid`, las fechas se fijan para que las pruebas sean deterministas y la ilustración se genera como SVG local dentro del fixture.",
  "La relación entre historias se basa en una entidad sintética compartida. La interfaz debe presentar el bloque de contexto solo cuando existen relaciones, y los enlaces originales deben abrir una pestaña aparte con `noopener noreferrer`.",
  "## Resultado esperado de la revisión",
  "Con esta ficha se revisan simultáneamente un título extenso, un resumen de varias frases, una imagen panorámica recortada desde una fuente vertical, tres fuentes, el bloque Por qué importa, un cuerpo con varias secciones y una tarjeta relacionada. La variante sin imagen cubre el tratamiento visual honesto cuando el dato no existe.",
  "El fixture se conserva exclusivamente en `scripts/` para pruebas locales. Las rutas temporales de vista previa se eliminan antes del build final, y el cargador público continúa leyendo únicamente la vista publicada de Supabase.",
].join("\n\n");

const articleFromSummary = (summary: PublicArticleSummary, body: string | null, whyItMatters: string | null): PublicArticle => ({
  ...summary,
  whyItMatters,
  body,
  updatedAt: summary.publishedAt,
});

export const VISUAL_QA_ARTICLES: readonly PublicArticle[] = [
  articleFromSummary(lead, longBody, "En la prueba, una misma ficha debe ayudar a comparar regiones sin ocultar qué datos son sintéticos, qué fuentes existen y qué información geográfica está ausente."),
  articleFromSummary(qaSummary({
    slug: "qa-berlin-open-weights",
    headline: "Dos equipos ficticios publican medidas compatibles",
    summary: "Nota sintética breve para comprobar una tarjeta sin imagen y dos historias en el mismo punto del mapa.",
    publishedAt: "2026-09-26T16:20:00.000Z",
    regionCode: "EU",
    regionName: "Europa",
    latitude: 52.52,
    longitude: 13.405,
    categories: [{ slug: "modelos", name: "Modelos" }],
    sources: [{ name: "Registro QA de modelos", url: "https://models.example.invalid/qa" }],
    entities: BASE_ENTITIES,
  }), "## Ensayo breve\n\nEste texto ficticio acompaña una tarjeta sin imagen.", null),
  articleFromSummary(qaSummary({
    slug: "qa-berlin-synthetic-robotics",
    headline: "Un prototipo de robótica aparece en el mismo lugar",
    summary: "La coordenada duplicada comprueba el agrupamiento de varias publicaciones en una sola ubicación.",
    publishedAt: "2026-09-26T12:15:00.000Z",
    regionCode: "EU",
    regionName: "Europa",
    latitude: 52.52,
    longitude: 13.405,
    categories: [{ slug: "robotica", name: "Robótica" }],
    sources: [{ name: "Bitácora robótica QA", url: "https://robotics.example.invalid/qa" }],
    entities: [{ type: "organization", name: "Taller Robótico Sintético", countryCode: null }],
  }), "## Ensayo de ubicación duplicada\n\nEsta historia solo existe para el fixture local.", null),
  articleFromSummary(qaSummary({
    slug: "qa-tokyo-edge-lab",
    headline: "Ensayo de borde en Tokio",
    summary: "Una noticia breve para comprobar variedad de densidad.",
    publishedAt: "2026-09-25T10:10:00.000Z",
    regionCode: "APAC",
    regionName: "Asia-Pacífico",
    latitude: 35.6762,
    longitude: 139.6503,
    categories: [{ slug: "infraestructura", name: "Infraestructura" }],
    sources: [{ name: "Notas sintéticas de infraestructura", url: "https://edge.example.invalid/qa" }],
    entities: BASE_ENTITIES,
  }), "## Ensayo en Asia\n\nUna ficha corta para la presentación de fuentes y metadatos.", null),
  articleFromSummary(qaSummary({
    slug: "qa-no-geography",
    headline: "Nota sintética sin categoría ni región",
    summary: "Esta ficha no tiene coordenadas y no debe generar un marcador.",
    publishedAt: "2026-09-24T08:00:00.000Z",
  }), "## Geografía ausente\n\nLa ausencia de coordenadas es intencional.", null),
];

export const VISUAL_QA_STORIES: readonly PublicArticleSummary[] = VISUAL_QA_ARTICLES;
