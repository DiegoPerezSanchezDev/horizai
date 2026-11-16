// Offline checks for the deterministic editorial grounding guard. No network.
import assert from "node:assert/strict";
import { analyzeEditorialGrounding } from "../lib/agents/editor/editor-grounding-guard.ts";
import { canonicalEditorInput, canonicalEditorialDraft } from "../lib/agents/editor/editor-fixtures.ts";

// The reviewed canonical draft stays valid.
assert.deepEqual(analyzeEditorialGrounding(canonicalEditorInput, canonicalEditorialDraft), []);

// Real case that reached human review on 2026-11-06: one verified fact, a padded draft that overclaims.
const sourceId = canonicalEditorInput.sources[0].sourceId;
const robotInput = {
  ...canonicalEditorInput,
  event: { eventKey: "robot", canonicalTitle: "I watched a humanoid robot clean my apartment. It felt like a taste of the future." },
  verification: { status: "confirmed", confidenceScore: 90, verifiedFacts: [{ claim: "The author watched a humanoid robot clean their apartment.", sourceIds: [sourceId] }], uncertainClaims: [], contradictions: [] },
  translation: { translatedTitle: "Vi a un robot humanoide limpiar mi apartamento", translatedFacts: [{ sourceText: "The author watched a humanoid robot clean their apartment.", translatedText: "El autor vio a un robot humanoide limpiar su apartamento.", sourceItemId: "i" }], translatedSourceMaterial: "El autor vio a un robot humanoide limpiar su apartamento.", preservedNames: [], translationNotes: [] },
  sources: [{ ...canonicalEditorInput.sources[0], sourceName: "MIT Technology Review" }],
};
const badDraft = {
  ...canonicalEditorialDraft, eventKey: "robot",
  headlineEs: "Robot humanoide limpia mi apartamento y el testimonio demuestra su eficacia",
  dekEs: "El autor relata cómo un robot de la serie de MIT Technology Review llevó a cabo tareas de limpieza en su hogar.",
  summaryEs: "Según el MIT Technology Review, el autor observó a un robot humanoide realizar labores de limpieza en su apartamento, lo que sugiere avances significativos en la automatización doméstica.",
  whyItMattersEs: "La demostración práctica indica progreso real.",
  bodyEs: "El MIT Technology Review informó que el autor presenció a un robot humanoide ejecutar la limpieza de su apartamento. El relato destaca la capacidad del robot para moverse, manipular objetos y mantener un entorno ordenado sin intervención humana directa. Este caso concreto muestra cómo las tecnologías emergentes de robótica y aprendizaje automático están avanzando hacia aplicaciones prácticas en el hogar, ofreciendo potenciales mejoras en la productividad y comodidad de los usuarios.",
  keyPoints: ["Robot humanoide limpia un apartamento real"],
};
const issues = analyzeEditorialGrounding(robotInput, badDraft);
const kinds = issues.map((i) => `${i.kind}:${i.detail.split(" ")[0]}`);
assert.ok(issues.some((i) => i.kind === "OVERREACH_TERM" && i.detail.startsWith("eficacia")), "efficacy claim must be flagged");
assert.ok(issues.some((i) => i.kind === "OVERREACH_TERM" && i.detail.startsWith("sin intervención")), "no-human-intervention claim must be flagged");
assert.ok(issues.some((i) => i.kind === "OVERREACH_TERM" && i.detail.startsWith("avances")), "significant-advances claim must be flagged");
assert.ok(issues.some((i) => i.kind === "UNGROUNDED_SENTENCE"), `filler sentence must be flagged (${kinds.join(", ")})`);

// A short, faithful draft for the same event passes.
const goodDraft = {
  ...badDraft,
  headlineEs: "Un periodista observa a un robot humanoide limpiar su apartamento",
  dekEs: "MIT Technology Review cuenta cómo el autor vio a un robot humanoide limpiar su casa.",
  summaryEs: "El autor de MIT Technology Review vio a un robot humanoide limpiar su apartamento.",
  whyItMattersEs: "Es un ejemplo de robótica doméstica probada en un hogar real.",
  bodyEs: "El autor vio a un robot humanoide limpiar su apartamento, según relata en MIT Technology Review. El texto es un relato en primera persona de esa experiencia.",
  keyPoints: ["El autor vio a un robot humanoide limpiar su apartamento."],
};
assert.deepEqual(analyzeEditorialGrounding(robotInput, goodDraft), []);

// Overreach words are allowed when the evidence itself uses them.
const withEvidence = { ...robotInput, verification: { ...robotInput.verification, verifiedFacts: [{ claim: "The company says the robot is effective and autonomous.", sourceIds: [sourceId] }] } };
assert.equal(analyzeEditorialGrounding(withEvidence, { ...goodDraft, summaryEs: "La empresa afirma que el robot es eficaz y autónomo." }).filter((i) => i.kind === "OVERREACH_TERM").length, 0);

import { validateEditorialDraftOutput } from "../lib/agents/editor/editor-output-guard.ts";
assert.throws(() => validateEditorialDraftOutput(robotInput, badDraft, { grounding: true }), (e) => e.code === "EDITOR_GROUNDING_REJECTED");
assert.doesNotThrow(() => validateEditorialDraftOutput(robotInput, goodDraft, { grounding: true }));

console.log("Editor grounding unit checks passed");
