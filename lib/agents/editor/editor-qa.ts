import { editorialDraftSchema, type EditorialDraft } from "../contracts/index.ts";
import type { EditorInput } from "./editor-types.ts";
import { analyzePreservedNames } from "./editor-output-guard.ts";

export const editorQaDimensions = [
  "FACTUAL_ACCURACY",
  "FACTUAL_PRECISION",
  "FIDELITY",
  "HEADLINE_QUALITY",
  "DEK_QUALITY",
  "SUMMARY_QUALITY",
  "WHY_IT_MATTERS",
  "BODY_QUALITY",
  "SPANISH_QUALITY",
  "UNCERTAINTY_PRESERVED",
  "NO_ADDED_FACTS",
  "NO_HALLUCINATIONS",
  "NO_CLICKBAIT",
  "NO_HYPE",
  "COPYRIGHT_SCOPE",
  "SOURCE_TRACEABILITY",
] as const;

export type EditorQaDimension = (typeof editorQaDimensions)[number];
export type EditorQaStatus = "PASS" | "WARNING" | "FAIL";
export type EditorQaCheck = { status: EditorQaStatus; reason?: string };
export type EditorQaResult = Record<EditorQaDimension, EditorQaCheck>;

export type EditorSafeSnapshot = {
  headlineEsChars: number;
  dekEsChars: number;
  summaryEsChars: number;
  whyItMattersEsChars: number;
  bodyEsChars: number;
  keyPointsCount: number;
  suggestedSlugValid: boolean;
  sample: {
    headlineEs: string;
    dekEs: string;
    whyItMattersEs: string;
    keyPoints: string[];
    bodyPreview: string;
  };
  qa: EditorQaResult;
};

const clickbaitPatterns = [
  /no te lo creer[aá]s/i,
  /todo lo que debes saber/i,
  /sacude (?:el|al) mundo/i,
  /cambiar[aá] todo/i,
  /la pregunta que todos/i,
];
const hypePatterns = [/revolucionari[oa]/i, /impresionante/i, /hist[oó]ric[oa]/i, /sin precedentes/i, /game[- ]changer/i];
const unsupportedConsequencePatterns = [
  /\bgarantiz(?:a|ar[aá]|ar[ií]a)/i,
  /\bdemuestra que\b/i,
  /\btransformar[aá]/i,
  /\brevolucionar[aá]/i,
  /\beliminar[aá]/i,
  /\bprovocar[aá]/i,
  /\bdominar[aá]/i,
];
const uncertaintyPatterns = [/\bpodr[ií]a\b/i, /\bposible\b/i, /\bposibilidad\b/i, /no (?:est[aá]|ha sido) confirmad/i, /sigue sin confirmar/i, /a[uú]n no/i, /seg[uú]n/i];

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function draftText(draft: EditorialDraft): string {
  return [draft.headlineEs, draft.dekEs, draft.summaryEs, draft.whyItMattersEs, draft.bodyEs, ...draft.keyPoints].join(" ");
}

function allowedMaterial(input: EditorInput): string {
  return [
    input.event.canonicalTitle,
    input.translation.translatedTitle,
    input.translation.translatedSourceMaterial,
    ...input.translation.translatedFacts.flatMap((fact) => [fact.sourceText, fact.translatedText]),
    ...input.translation.preservedNames,
    ...input.verification.verifiedFacts.map((fact) => fact.claim),
    ...input.verification.uncertainClaims.map((claim) => claim.claim),
    ...input.verification.contradictions.map((claim) => claim.claim),
    ...input.sources.map((source) => source.sourceName),
  ].join(" ");
}

function concreteTokens(value: string): string[] {
  return value.match(/(?:\$|€|£)\s?\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?(?:K|M|B)?%?\b|\b[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*\d+[A-Za-z0-9.-]*\b/gi) ?? [];
}

function hasUnsupportedConcreteData(input: EditorInput, draft: EditorialDraft): boolean {
  const allowed = new Set(concreteTokens(allowedMaterial(input)).map(normalize));
  return concreteTokens(draftText(draft)).some((token) => !allowed.has(normalize(token)));
}

function includesLongSourceBlock(source: string, body: string): boolean {
  const normalizedSource = normalize(source);
  const normalizedBody = normalize(body);
  if (normalizedSource.length < 180) return false;
  for (let start = 0; start + 180 <= normalizedSource.length; start += 90) {
    if (normalizedBody.includes(normalizedSource.slice(start, start + 180))) return true;
  }
  return false;
}

function check(status: EditorQaStatus, reason?: string): EditorQaCheck {
  return reason ? { status, reason } : { status };
}

export function evaluateEditorQa(input: EditorInput, draft: EditorialDraft): EditorQaResult {
  const unsupportedConcreteData = hasUnsupportedConcreteData(input, draft);
  const allText = draftText(draft);
  const clickbait = clickbaitPatterns.some((pattern) => pattern.test(draft.headlineEs));
  const hype = hypePatterns.some((pattern) => pattern.test(allText));
  const unsupportedConsequence = unsupportedConsequencePatterns.some((pattern) => pattern.test(draft.whyItMattersEs))
    && !unsupportedConsequencePatterns.some((pattern) => pattern.test(allowedMaterial(input)));
  const uncertainInput = input.verification.uncertainClaims.length > 0;
  const uncertaintyPreserved = !uncertainInput || uncertaintyPatterns.some((pattern) => pattern.test(allText));
  const sourceIds = new Set(input.sources.map((source) => source.sourceId));
  const sourceReferencesValid = [
    ...input.verification.verifiedFacts,
    ...input.verification.uncertainClaims,
    ...input.verification.contradictions,
  ].every((claim) => claim.sourceIds.every((sourceId) => sourceIds.has(sourceId)));
  const preservedNameReport = analyzePreservedNames(input, draft);
  const copiedSource = includesLongSourceBlock(input.translation.translatedSourceMaterial, draft.bodyEs);
  const spanishMarkers = allText.match(/\b(?:el|la|los|las|de|del|que|para|con|por|una|un|según|modelo|empresa)\b/gi)?.length ?? 0;
  const whyAddsValue = normalize(draft.whyItMattersEs) !== normalize(draft.summaryEs)
    && /\b(?:permite|ayuda|importa|relevancia|impacto|alcance|capacidad|contexto|implica|muestra)\b/i.test(draft.whyItMattersEs);

  return {
    FACTUAL_ACCURACY: unsupportedConcreteData
      ? check("FAIL", "El draft introduce datos concretos ausentes del material permitido.")
      : check("PASS"),
    FACTUAL_PRECISION: unsupportedConcreteData
      ? check("FAIL", "Se detectaron datos concretos no respaldados por el material permitido.")
      : check("PASS"),
    FIDELITY: unsupportedConcreteData || !sourceReferencesValid
      ? check("FAIL", "El draft no conserva una relación verificable con el material permitido.")
      : check("PASS"),
    HEADLINE_QUALITY: clickbait || draft.headlineEs.includes("?")
      ? check("FAIL", "El titular utiliza una formulación clickbait o interrogativa.")
      : normalize(draft.headlineEs) === normalize(input.translation.translatedTitle)
        ? check("WARNING", "El titular es demasiado próximo al título traducido.")
        : check("PASS"),
    DEK_QUALITY: normalize(draft.dekEs) === normalize(draft.summaryEs)
      ? check("WARNING", "El dek repite el resumen sin aportar jerarquía.")
      : check("PASS"),
    SUMMARY_QUALITY: draft.summaryEs.length < 30
      ? check("FAIL", "El resumen no alcanza la longitud contractual.")
      : check("PASS"),
    WHY_IT_MATTERS: unsupportedConsequence
      ? check("FAIL", "Introduce una consecuencia fuerte no sustentada por el input.")
      : whyAddsValue
        ? check("PASS")
        : check("WARNING", "La relevancia no queda claramente diferenciada del resumen."),
    BODY_QUALITY: draft.bodyEs.length < 100
      ? check("FAIL", "El cuerpo no alcanza la longitud contractual.")
      : check("PASS"),
    SPANISH_QUALITY: spanishMarkers < 5
      ? check("WARNING", "La señal lingüística disponible no permite confirmar español natural.")
      : check("PASS"),
    UNCERTAINTY_PRESERVED: uncertaintyPreserved
      ? check("PASS")
      : check("FAIL", "Existe una afirmación incierta, pero el draft no conserva señales de incertidumbre."),
    NO_ADDED_FACTS: unsupportedConcreteData
      ? check("FAIL", "Se detectaron datos concretos nuevos sin soporte.")
      : check("PASS"),
    NO_HALLUCINATIONS: unsupportedConcreteData
      ? check("FAIL", "Se detectaron datos concretos no rastreables.")
      : check("WARNING", "No se detectaron datos concretos nuevos; la revisión semántica humana sigue siendo necesaria."),
    NO_CLICKBAIT: clickbait
      ? check("FAIL", "El titular contiene un patrón de clickbait.")
      : check("PASS"),
    NO_HYPE: hype
      ? check("FAIL", "El draft contiene lenguaje hiperbólico no justificado.")
      : check("PASS"),
    COPYRIGHT_SCOPE: copiedSource
      ? check("FAIL", "El cuerpo reproduce un bloque extenso del material traducido.")
      : check("PASS"),
    SOURCE_TRACEABILITY: sourceReferencesValid && preservedNameReport.mutatedPreservedNames.length === 0
      ? check("PASS")
      : check("FAIL", "La trazabilidad de fuentes o nombres preservados no es coherente."),
  };
}

export function buildEditorSafeSnapshot(input: EditorInput, draft: EditorialDraft): EditorSafeSnapshot {
  return {
    headlineEsChars: draft.headlineEs.length,
    dekEsChars: draft.dekEs.length,
    summaryEsChars: draft.summaryEs.length,
    whyItMattersEsChars: draft.whyItMattersEs.length,
    bodyEsChars: draft.bodyEs.length,
    keyPointsCount: draft.keyPoints.length,
    suggestedSlugValid: editorialDraftSchema.shape.suggestedSlug.safeParse(draft.suggestedSlug).success,
    sample: {
      headlineEs: draft.headlineEs,
      dekEs: draft.dekEs,
      whyItMattersEs: draft.whyItMattersEs,
      keyPoints: [...draft.keyPoints],
      bodyPreview: draft.bodyEs.slice(0, 500),
    },
    qa: evaluateEditorQa(input, draft),
  };
}
