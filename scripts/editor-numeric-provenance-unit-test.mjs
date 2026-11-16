import assert from "node:assert/strict";
import { canonicalEditorInput, canonicalEditorialDraft } from "../lib/agents/editor/editor-fixtures.ts";
import { analyzeEditorialNumericClaims } from "../lib/agents/editor/editor-numeric-provenance.ts";
import { validateEditorialDraftOutput } from "../lib/agents/editor/editor-output-guard.ts";
import { AgentError } from "../lib/agents/runtime/agent-errors.ts";

const addMaterial = (text) => ({
  ...canonicalEditorInput,
  translation: { ...canonicalEditorInput.translation, translatedSourceMaterial: `${canonicalEditorInput.translation.translatedSourceMaterial} ${text}` },
  verification: { ...canonicalEditorInput.verification, verifiedFacts: [...canonicalEditorInput.verification.verifiedFacts, { claim: text, sourceIds: [canonicalEditorInput.sources[0].sourceId] }] },
});
const replaceDraft = (text) => ({ ...canonicalEditorialDraft, bodyEs: `${canonicalEditorialDraft.bodyEs} ${text}` });

const canonicalReport = analyzeEditorialNumericClaims(canonicalEditorInput, canonicalEditorialDraft);
assert.equal(canonicalReport.rejectedNumericClaims.length, 0);
assert.ok(canonicalReport.allowedNumericClaims.some((claim) => claim.observedForm === "128K"));
assert.ok(canonicalReport.matchedProvenance.some((claim) => claim.outputObservedForm === "128K" && claim.outputCanonicalValue === "128000"));
validateEditorialDraftOutput(canonicalEditorInput, canonicalEditorialDraft);

for (const separator of [" ", "\u00A0", "\u202F"]) {
  const grouped = `128${separator}000`;
  const report = analyzeEditorialNumericClaims(addMaterial("The capacity was 128K."), replaceDraft(`La capacidad fue de ${grouped} tokens.`));
  const claim = report.detectedNumericClaims.find((item) => item.observedForm === grouped);
  assert.ok(claim, `grouped form must be one claim for code point ${separator.codePointAt(0)?.toString(16)}`);
  assert.equal(claim.canonicalValue, "128000");
  assert.equal(claim.claimType, "quantity");
  assert.equal(report.rejectedNumericClaims.length, 0);
  assert.ok(report.matchedProvenance.some((item) => item.outputObservedForm === grouped && item.inputObservedForm === "128K" && item.matchReason === "exact_quantity_normalization"));
}
const largeGrouped = analyzeEditorialNumericClaims(addMaterial("The value was 1 234 567."), replaceDraft("El valor fue 1 234 567."));
assert.equal(largeGrouped.rejectedNumericClaims.length, 0);
assert.equal(largeGrouped.detectedNumericClaims.find((item) => item.observedForm === "1 234 567")?.canonicalValue, "1234567");
for (const invalidGrouping of ["128 00", "12 34"]) {
  const invalid = analyzeEditorialNumericClaims(addMaterial("The value was 128K."), replaceDraft(`El valor fue ${invalidGrouping}.`));
  assert.ok(invalid.rejectedNumericClaims.some((item) => item.observedForm === invalidGrouping || item.observedForm === invalidGrouping.split(" ")[0]));
}
const spacedDate = analyzeEditorialNumericClaims(addMaterial("The date was 12 September 2026."), replaceDraft("La fecha fue 12 09 2026."));
assert.equal(spacedDate.detectedNumericClaims.some((item) => item.canonicalValue === "12092026"), false);

for (const output of ["128000", "128,000", "128.000"]) {
  const report = analyzeEditorialNumericClaims(canonicalEditorInput, { ...canonicalEditorialDraft, bodyEs: canonicalEditorialDraft.bodyEs.replaceAll("128K", output) });
  assert.equal(report.rejectedNumericClaims.length, 0, `128K must match ${output}`);
}
const quantityReport = analyzeEditorialNumericClaims(addMaterial("The capacity was 4.2B."), replaceDraft("La capacidad fue de 4.200 millones."));
assert.equal(quantityReport.rejectedNumericClaims.length, 0);
assert.equal(analyzeEditorialNumericClaims(addMaterial("The capacity was 4.2B."), replaceDraft("La capacidad fue de 4B.")).rejectedNumericClaims.length > 0, true);
assert.equal(analyzeEditorialNumericClaims(addMaterial("The capacity was 4.2B."), replaceDraft("La capacidad fue de 4.3B.")).rejectedNumericClaims.length > 0, true);

const percentageInput = addMaterial("The increase was 50%.");
assert.equal(analyzeEditorialNumericClaims(percentageInput, replaceDraft("El aumento fue del 50 %.")).rejectedNumericClaims.length, 0);
assert.equal(analyzeEditorialNumericClaims(percentageInput, replaceDraft("El aumento fue del 49%.")).rejectedNumericClaims.length > 0, true);

const dateInput = addMaterial("The announcement date was 12 September 2026.");
const dateOutput = { ...canonicalEditorialDraft, dekEs: "La fecha del anuncio fue 12/09/2026 y la disponibilidad sigue sin confirmarse." };
const dateReport = analyzeEditorialNumericClaims(dateInput, dateOutput);
assert.equal(dateReport.rejectedNumericClaims.length, 0);
assert.ok(dateReport.matchedProvenance.some((claim) => claim.outputObservedForm === "12/09/2026" && claim.outputCanonicalValue === "2026-09-12"));
assert.equal(analyzeEditorialNumericClaims(dateInput, { ...canonicalEditorialDraft, dekEs: "La fecha del anuncio fue 09 empresas." }).rejectedNumericClaims.length > 0, true);
assert.equal(analyzeEditorialNumericClaims(addMaterial("September 2026."), replaceDraft("La referencia fue 09 empresas.")).rejectedNumericClaims.length > 0, true);

const nominalDraft = replaceDraft("También menciona GPT-5.6 y Reasoner-1.");
const nominalReport = analyzeEditorialNumericClaims(canonicalEditorInput, nominalDraft);
assert.ok(nominalReport.rejectedNumericClaims.some((claim) => claim.observedForm === "GPT-5.6"));
assert.equal(nominalReport.rejectedNumericClaims.some((claim) => claim.observedForm === "5.6" || claim.observedForm === "1"), false);
const versionInput = addMaterial("The model is named GPT-5.6.");
assert.equal(analyzeEditorialNumericClaims(versionInput, nominalDraft).rejectedNumericClaims.length, 0);
for (const separator of ["-", "\u2010", "\u2011"]) {
  const identifier = `Reasoner${separator}1`;
  const variantDraft = { ...canonicalEditorialDraft, headlineEs: `El modelo ${identifier} llega con una ventana de contexto de 128K tokens`, bodyEs: canonicalEditorialDraft.bodyEs.replaceAll("Reasoner-1", identifier) };
  const report = analyzeEditorialNumericClaims(canonicalEditorInput, variantDraft);
  assert.equal(report.rejectedNumericClaims.length, 0);
  const nominal = report.detectedNumericClaims.find((claim) => claim.observedForm === identifier);
  assert.equal(nominal?.claimType, "nominal_identifier");
  assert.equal(nominal?.canonicalValue, "reasoner-1");
  assert.equal(report.detectedNumericClaims.some((claim) => claim.sourceStage === "draft" && claim.observedForm === "1"), false);
}

// Regression for the historical provider output: a non-breaking hyphen in a
// nominal identifier must never expose its suffix as an independent number.
const historicalNominal = Object.fromEntries(Object.entries(canonicalEditorialDraft).map(([key, value]) => [
  key,
  typeof value === "string" ? value.replaceAll("Reasoner-1", "Reasoner\u20111") : Array.isArray(value) ? value.map((item) => typeof item === "string" ? item.replaceAll("Reasoner-1", "Reasoner\u20111") : item) : value,
]));
const historicalReport = analyzeEditorialNumericClaims(canonicalEditorInput, historicalNominal);
assert.equal(historicalReport.rejectedNumericClaims.some((claim) => claim.observedForm === "1"), false);
assert.equal(historicalReport.rejectedNumericClaims.length, 0);
for (const separator of ["-", "\u2010", "\u2011"]) {
  const identifier = `GPT${separator}5.6`;
  const report = analyzeEditorialNumericClaims(addMaterial("The model is named GPT-5.6."), replaceDraft(`El modelo se identifica como ${identifier}.`));
  assert.equal(report.rejectedNumericClaims.length, 0);
  assert.equal(report.detectedNumericClaims.find((claim) => claim.observedForm === identifier)?.claimType, "model_version");
  assert.equal(report.detectedNumericClaims.find((claim) => claim.observedForm === identifier)?.canonicalValue, "gpt-5.6");
}
assert.equal(analyzeEditorialNumericClaims(canonicalEditorInput, replaceDraft("La referencia fue Reasoner-2.")).rejectedNumericClaims.some((claim) => claim.observedForm === "Reasoner-2"), true);
assert.equal(analyzeEditorialNumericClaims(versionInput, replaceDraft("La referencia fue GPT-5.7.")).rejectedNumericClaims.some((claim) => claim.observedForm === "GPT-5.7"), true);
for (const range of ["5-10", "5–10", "-5", "2025-2026"]) {
  const report = analyzeEditorialNumericClaims(canonicalEditorInput, replaceDraft(`Rango ${range}.`));
  assert.equal(report.detectedNumericClaims.some((claim) => claim.observedForm === range && (claim.claimType === "nominal_identifier" || claim.claimType === "model_version")), false);
}
assert.equal(analyzeEditorialNumericClaims(canonicalEditorInput, { ...canonicalEditorialDraft, dekEs: "La fecha fue 12/09/2026." }).detectedNumericClaims.some((claim) => claim.claimType === "date" && claim.canonicalValue === "2026-09-12"), true);
assert.equal(analyzeEditorialNumericClaims(canonicalEditorInput, replaceDraft("Se anunciaron 2026 acuerdos.")).rejectedNumericClaims.some((claim) => claim.claimType === "quantity" && claim.observedForm === "2026"), true);

const invented = replaceDraft("El coste fue de 9999 euros.");
assert.ok(analyzeEditorialNumericClaims(canonicalEditorInput, invented).rejectedNumericClaims.some((claim) => claim.observedForm === "9999"));
assert.throws(() => validateEditorialDraftOutput(canonicalEditorInput, invented));
assert.equal(analyzeEditorialNumericClaims(addMaterial("The value was 128K."), replaceDraft("El valor fue de 130,000.")).rejectedNumericClaims.length > 0, true);

const unsupportedDate = replaceDraft("La compañía comenzó sus operaciones en 2021.");
const unsupportedDateReport = analyzeEditorialNumericClaims(canonicalEditorInput, unsupportedDate);
assert.ok(unsupportedDateReport.rejectedNumericClaims.some((claim) => claim.observedForm === "2021"));
assert.throws(() => validateEditorialDraftOutput(canonicalEditorInput, unsupportedDate), (error) => {
  assert.ok(error instanceof AgentError);
  assert.equal(error.code, "EDITOR_GROUNDING_REJECTED");
  assert.equal(error.diagnostics?.failureKind, "DETERMINISTIC_GROUNDING_REJECTION");
  assert.equal(error.diagnostics?.tokenType, "year");
  return true;
});

console.log("Editor numeric provenance fixtures passed");
