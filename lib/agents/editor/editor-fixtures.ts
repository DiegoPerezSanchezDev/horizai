import type { EditorialDraft } from "../contracts/index.ts";
import type { EditorInput } from "./editor-types.ts";

export const editorSourceId = "11111111-1111-4111-8111-111111111111";
export const editorSourceUrl = "https://example.com/ai-reasoning-model";
export const editorEventKey = "fixture-editor-event";

export const canonicalEditorInput: EditorInput = {
  schemaVersion: 1,
  event: {
    eventKey: editorEventKey,
    canonicalTitle: "AI reasoning model announcement",
  },
  verification: {
    status: "confirmed",
    confidenceScore: 90,
    verifiedFacts: [
      { claim: "The company announced Reasoner-1 on 12 September 2026.", sourceIds: [editorSourceId] },
      { claim: "Reasoner-1 supports a 128K-token context window.", sourceIds: [editorSourceId] },
    ],
    uncertainClaims: [
      { claim: "The model may become available to all developers in October 2026.", sourceIds: [editorSourceId] },
    ],
    contradictions: [],
  },
  translation: {
    translatedTitle: "Anuncio de un modelo de razonamiento de IA",
    translatedFacts: [
      { sourceText: "The company announced Reasoner-1 on 12 September 2026.", translatedText: "La empresa anunció Reasoner-1 el 12 de septiembre de 2026.", sourceItemId: "fixture-editor-item" },
      { sourceText: "Reasoner-1 supports a 128K-token context window.", translatedText: "Reasoner-1 admite una ventana de contexto de 128K tokens.", sourceItemId: "fixture-editor-item" },
    ],
    translatedSourceMaterial: "La empresa anunció Reasoner-1 el 12 de septiembre de 2026 y señaló que admite una ventana de contexto de 128K tokens. La disponibilidad general para desarrolladores en octubre de 2026 sigue siendo una posibilidad no confirmada.",
    preservedNames: ["Reasoner-1"],
    translationNotes: [],
  },
  sources: [{ sourceId: editorSourceId, sourceName: "Fixture source", canonicalUrl: editorSourceUrl, sourceType: "official_blog" }],
};

export const canonicalEditorialDraft: EditorialDraft = {
  schemaVersion: 1,
  eventKey: editorEventKey,
  headlineEs: "Reasoner-1 llega con una ventana de contexto de 128K tokens",
  dekEs: "La empresa presentó el modelo el 12 de septiembre; su disponibilidad general en octubre aún no está confirmada.",
  summaryEs: "La empresa anunció Reasoner-1 el 12 de septiembre de 2026 y destacó que admite una ventana de contexto de 128K tokens. La posible disponibilidad para todos los desarrolladores en octubre sigue sin confirmarse.",
  whyItMattersEs: "La combinación de una fecha de lanzamiento concreta y una ventana de contexto de 128K tokens ayuda a medir el alcance técnico del anuncio. La disponibilidad general sigue siendo incierta, por lo que no debe tratarse como un lanzamiento confirmado.",
  bodyEs: "La empresa anunció Reasoner-1 el 12 de septiembre de 2026. Según el material verificado, el modelo admite una ventana de contexto de 128K tokens. Ese dato describe una capacidad concreta, pero no permite por sí solo concluir cómo rendirá frente a otros sistemas. La disponibilidad general para todos los desarrolladores en octubre de 2026 aparece como una posibilidad, no como un hecho confirmado. HorizAI mantiene esa distinción porque el anuncio procede de una única fuente registrada.",
  keyPoints: [
    "Reasoner-1 fue anunciado el 12 de septiembre de 2026.",
    "El modelo admite una ventana de contexto de 128K tokens.",
    "La disponibilidad general en octubre de 2026 no está confirmada.",
  ],
  suggestedSlug: "reasoner-1-llega-con-una-ventana-de-contexto-de-128k-tokens",
};

export const canonicalEditorGeneration = {
  headlineEs: canonicalEditorialDraft.headlineEs,
  dekEs: canonicalEditorialDraft.dekEs,
  summaryEs: canonicalEditorialDraft.summaryEs,
  whyItMattersEs: canonicalEditorialDraft.whyItMattersEs,
  bodyEs: canonicalEditorialDraft.bodyEs,
  keyPoints: canonicalEditorialDraft.keyPoints,
};

export const editorOutputShapeExample = JSON.stringify(canonicalEditorialDraft);
export const editorGenerationShapeExample = JSON.stringify(canonicalEditorGeneration);
