import { AgentError } from "../runtime/agent-errors.ts";
import { editorialDraftSchema, type EditorialDraft } from "../contracts/index.ts";
import type { EditorInput } from "./editor-types.ts";
import { analyzeEditorialNumericClaims, numericGuardDiagnostics } from "./editor-numeric-provenance.ts";
import { analyzeEditorialGrounding } from "./editor-grounding-guard.ts";

export type PreservedNameGuardReport = {
  preservedNamesCount: number;
  preservedNamesObservedCount: number;
  omittedPreservedNames: string[];
  mutatedPreservedNames: string[];
};

function fail(message: string, diagnostics?: import("../runtime/runtime-types.ts").ProviderDiagnostics): never {
  throw new AgentError("invalid_structured_output", `Editorial draft deterministic guard failed: ${message}`, undefined, {
    ...diagnostics,
    validationResult: "invalid",
    failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR",
    finalEditorialDraftValid: false,
  });
}

function rejectUnsupportedGrounding(message: string, diagnostics: import("../runtime/runtime-types.ts").ProviderDiagnostics): never {
  throw new AgentError("EDITOR_GROUNDING_REJECTED", `Editorial draft deterministic grounding rejected: ${message}`, undefined, {
    ...diagnostics,
    validationResult: "invalid",
    failureKind: "DETERMINISTIC_GROUNDING_REJECTION",
    finalEditorialDraftValid: false,
  });
}

function allDraftText(draft: EditorialDraft): string {
  return [draft.headlineEs, draft.dekEs, draft.summaryEs, draft.whyItMattersEs, draft.bodyEs, ...draft.keyPoints].join(" ");
}

function normalizeSafeTypography(value: string): string {
  return value.replace(/[\u2010\u2011]/g, "-");
}

function containsPreservedName(text: string, name: string): boolean {
  return text.includes(name) || normalizeSafeTypography(text).includes(normalizeSafeTypography(name));
}

const nominalIdentifierPattern = /\b[A-Za-z][A-Za-z0-9]*[-\u2010\u2011_]\d+(?:\.\d+)?(?:[A-Za-z0-9.-]*)\b/g;

function nominalStem(value: string): string | null {
  const match = value.match(/^([A-Za-z][A-Za-z0-9]*)[-\u2010\u2011_]/);
  return match?.[1].toLocaleLowerCase() ?? null;
}

function findMutatedNominalNames(text: string, name: string): boolean {
  const expected = normalizeSafeTypography(name).toLocaleLowerCase();
  const stem = nominalStem(name);
  if (!stem) return false;
  for (const match of text.matchAll(nominalIdentifierPattern)) {
    const candidate = normalizeSafeTypography(match[0]).toLocaleLowerCase();
    if (nominalStem(candidate) === stem && candidate !== expected) return true;
  }
  return false;
}

export function analyzePreservedNames(input: EditorInput, draft: EditorialDraft): PreservedNameGuardReport {
  const text = allDraftText(draft);
  const omittedPreservedNames: string[] = [];
  const mutatedPreservedNames: string[] = [];
  let preservedNamesObservedCount = 0;
  for (const name of input.translation.preservedNames) {
    if (containsPreservedName(text, name)) {
      preservedNamesObservedCount += 1;
    } else if (findMutatedNominalNames(text, name)) {
      mutatedPreservedNames.push(name);
    } else {
      omittedPreservedNames.push(name);
    }
  }
  return {
    preservedNamesCount: input.translation.preservedNames.length,
    preservedNamesObservedCount,
    omittedPreservedNames,
    mutatedPreservedNames,
  };
}

function preservedNameDiagnostics(report: PreservedNameGuardReport, guardFailureType?: "PRESERVED_NAME_MUTATED"): import("../runtime/runtime-types.ts").ProviderDiagnostics {
  return {
    ...(guardFailureType ? { guardFailureType } : {}),
    ...report,
  };
}

/** `grounding` is opt-in: only the Editor applies it to fresh model output. Critic and Publisher re-checks keep the structural guards. */
export function validateEditorialDraftOutput(input: EditorInput, draft: EditorialDraft, options: { grounding?: boolean } = {}): PreservedNameGuardReport {
  const parsed = editorialDraftSchema.safeParse(draft);
  if (!parsed.success) fail("output does not match EditorialDraft");
  if (draft.eventKey !== input.event.eventKey) fail("eventKey does not match input event");
  if (draft.headlineEs.trim().toLocaleLowerCase() === input.event.canonicalTitle.trim().toLocaleLowerCase()) {
    fail("headline repeats the canonical event title exactly");
  }

  const draftText = allDraftText(draft);
  const allowedUrls = new Set(input.sources.map((source) => source.canonicalUrl));
  const urls = draftText.match(/https?:\/\/[^\s)]+/gi) ?? [];
  if (urls.some((url) => !allowedUrls.has(url))) fail("draft contains a URL not present in the input");

  const preservedNameReport = analyzePreservedNames(input, draft);
  if (preservedNameReport.mutatedPreservedNames.length > 0) {
    fail(
      `preserved name was mutated: ${preservedNameReport.mutatedPreservedNames.join(", ")}`,
      preservedNameDiagnostics(preservedNameReport, "PRESERVED_NAME_MUTATED"),
    );
  }

  const numericReport = analyzeEditorialNumericClaims(input, draft);
  if (numericReport.rejectedNumericClaims.length > 0) {
    rejectUnsupportedGrounding("draft introduces a numeric or date token absent from allowed material", numericGuardDiagnostics(numericReport));
  }

  const groundingIssues = options.grounding ? analyzeEditorialGrounding(input, draft) : [];
  if (groundingIssues.length > 0) {
    const first = groundingIssues[0];
    rejectUnsupportedGrounding(`draft says more than the verified material (${first.kind} in ${first.field}: ${first.detail})`, {
      guardFailureType: "EDITORIAL_UNGROUNDED_CONTENT",
      failureReasonCode: "EDITORIAL_UNGROUNDED_CONTENT",
    });
  }

  const longSourceMaterial = input.translation.translatedSourceMaterial.trim();
  if (longSourceMaterial.length >= 180 && draft.bodyEs.includes(longSourceMaterial)) {
    fail("body reproduces the complete translated source material");
  }

  return preservedNameReport;
}
