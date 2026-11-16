import type { EditorialDraft } from "../contracts/index.ts";
import type { ProviderDiagnostics } from "../runtime/runtime-types.ts";
import type { EditorInput } from "./editor-types.ts";

export type NumericClaimType = "quantity" | "percentage" | "currency" | "date" | "year" | "model_version" | "nominal_identifier" | "unknown_numeric";
export type NumericClaim = {
  normalizedValue: string;
  observedForm: string;
  canonicalValue: string | null;
  claimType: NumericClaimType;
  sourceStage: "draft" | "event" | "translation" | "verification";
  sourceField: string;
  contextBefore?: string;
  contextAfter?: string;
};
export type MatchedNumericProvenance = {
  outputObservedForm: string;
  outputCanonicalValue: string;
  inputObservedForm: string;
  inputCanonicalValue: string;
  claimType: NumericClaimType;
  sourceStage: "event" | "translation" | "verification";
  sourceField: string;
  matchReason: "exact_canonical_value" | "exact_suffix_normalization" | "exact_quantity_normalization" | "exact_date_normalization";
};
export type NumericGuardReport = {
  detectedNumericClaims: NumericClaim[];
  allowedNumericClaims: NumericClaim[];
  rejectedNumericClaims: NumericClaim[];
  matchedProvenance: MatchedNumericProvenance[];
  provenance: NumericClaim[];
};

const months: Record<string, string> = { january: "01", enero: "01", february: "02", febrero: "02", march: "03", marzo: "03", april: "04", abril: "04", may: "05", mayo: "05", june: "06", junio: "06", july: "07", julio: "07", august: "08", agosto: "08", september: "09", septiembre: "09", october: "10", octubre: "10", november: "11", noviembre: "11", december: "12", diciembre: "12" };
const nominalPattern = /\b[A-Za-z][A-Za-z0-9]*[-\u2010\u2011_]\d+(?:\.\d+)?(?:[A-Za-z0-9.-]*)\b/g;
const groupingSeparator = "[ \\u00A0\\u202F\\u2009]";
const numericPattern = new RegExp(`\\b\\d{1,3}(?:${groupingSeparator}\\d{3})+\\b|\\b\\d+(?:[.,]\\d+)?(?:K|M|B)?%?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}:\\d{2}\\b|(?:\\$|€|£)\\s?\\d+(?:[.,]\\d+)?`, "gi");
const quantityWordPattern = /\b(\d[\d.,]*)\s+(mil millones|billion|billions|millones|millions|million|miles|thousand|thousands|mil)\b/gi;
const datePattern = /\b(\d{1,2})\s+(?:de\s+)?(January|February|March|April|May|June|July|August|September|October|November|December|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?(\d{4})\b|\b(January|February|March|April|May|June|July|August|September|October|November|December|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(\d{1,2}),?\s+(\d{4})\b|\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/gi;
const partialDatePattern = /\b(\d{1,2})\s+(?:de\s+)?(January|February|March|April|May|June|July|August|September|October|November|December|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/gi;
const quantityWords = /\b(?:acuerdos?|empresas?|usuarios?|casos?|unidades?|modelos?|tokens?|millones?|miles?|billones?|billion|millions?|thousands?)\b/i;

function normalizeText(value: string): string { return value.replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim().toLocaleLowerCase(); }
function normalizeNominal(value: string): string { return value.replace(/[\u002D\u2010\u2011]/g, "-").toLocaleLowerCase(); }
function context(text: string, start: number, end: number): { before: string; after: string } { return { before: text.slice(Math.max(0, start - 40), start), after: text.slice(end, Math.min(text.length, end + 40)) }; }
function numericRanges(text: string): Array<[number, number]> { return [...text.matchAll(nominalPattern)].flatMap((match) => match.index === undefined ? [] : [[match.index, match.index + match[0].length] as [number, number]]); }
function isInside(start: number, end: number, ranges: Array<[number, number]>): boolean { return ranges.some(([from, to]) => start >= from && end <= to); }
function parseLocaleNumber(raw: string): number | null {
  const value = raw.trim().replace(/[ \u00A0\u202F\u2009]/g, ""); if (!/^\d[\d.,]*$/.test(value)) return null;
  const commas = (value.match(/,/g) ?? []).length; const dots = (value.match(/\./g) ?? []).length; let normalized = value;
  if (commas > 0 && dots > 0) { const decimal = Math.max(value.lastIndexOf(","), value.lastIndexOf(".")); const fractional = value.slice(decimal + 1); normalized = fractional.length === 3 ? value.replace(/[.,]/g, "") : `${value.slice(0, decimal).replace(/[.,]/g, "")}.${fractional}`; }
  else if (commas === 1 || dots === 1) { const separator = commas === 1 ? "," : "."; const parts = value.split(separator); normalized = parts[1]?.length === 3 ? parts.join("") : parts.join("."); }
  else if (commas > 1 || dots > 1) normalized = value.replace(/[.,]/g, "");
  const parsed = Number(normalized); return Number.isFinite(parsed) ? parsed : null;
}
function canonicalNumber(value: number): string | null { return Number.isFinite(value) ? Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, "") : null; }
function quantityCanonical(raw: string, suffix?: string): string | null { const number = parseLocaleNumber(raw); if (number === null) return null; const multiplier = suffix ? ({ k: 1_000, m: 1_000_000, b: 1_000_000_000 }[suffix.toLocaleLowerCase()] ?? null) : 1; return multiplier === null ? null : canonicalNumber(number * multiplier); }
function quantityWordCanonical(raw: string, unit: string): string | null { const number = parseLocaleNumber(raw); if (number === null) return null; const lower = unit.toLocaleLowerCase(); const multiplier = lower === "mil millones" || lower.startsWith("billion") ? 1_000_000_000 : lower === "millones" || lower.startsWith("million") ? 1_000_000 : lower === "miles" || lower.startsWith("thousand") || lower === "mil" ? 1_000 : null; return multiplier === null ? null : canonicalNumber(number * multiplier); }
function dateCanonical(day: string, month: string, year: string): string | null { const monthNumber = months[month.toLocaleLowerCase()]; const d = Number(day); if (!monthNumber || !Number.isInteger(d) || d < 1 || d > 31) return null; const iso = `${year}-${monthNumber}-${String(d).padStart(2, "0")}`; const parsed = new Date(`${iso}T00:00:00Z`); return parsed.toISOString().slice(0, 10) === iso ? iso : null; }
function dateMatches(text: string): Array<{ start: number; end: number; form: string; canonical: string }> {
  const matches: Array<{ start: number; end: number; form: string; canonical: string }> = [];
  for (const match of text.matchAll(datePattern)) {
    if (match.index === undefined) continue;
    const [, dayName, monthName, yearName, monthDayName, monthDay, monthYear, slashDay, slashMonth, slashYear] = match;
    const numericMonth = Object.entries(months).find(([, value]) => value === String(Number(slashMonth)).padStart(2, "0"))?.[0] ?? "";
    const canonical = dayName && monthName && yearName ? dateCanonical(dayName, monthName, yearName) : monthDayName && monthDay && monthYear ? dateCanonical(monthDay, monthDayName, monthYear) : slashDay && slashMonth && slashYear ? dateCanonical(slashDay, numericMonth, slashYear) : null;
    if (canonical) matches.push({ start: match.index, end: match.index + match[0].length, form: match[0], canonical });
  }
  for (const match of text.matchAll(partialDatePattern)) {
    if (match.index === undefined || matches.some((date) => match.index! >= date.start && match.index! < date.end)) continue;
    const day = Number(match[1]); const month = months[match[2].toLocaleLowerCase()];
    if (month && Number.isInteger(day) && day >= 1 && day <= 31) matches.push({ start: match.index, end: match.index + match[0].length, form: match[0], canonical: `--${month}-${String(day).padStart(2, "0")}` });
  }
  return matches;
}
function claimsFromText(text: string, sourceStage: NumericClaim["sourceStage"], sourceField: string): NumericClaim[] {
  const ranges = numericRanges(text); const dates = dateMatches(text); const wordQuantities = [...text.matchAll(quantityWordPattern)].flatMap((match) => { const canonical = match.index === undefined ? null : quantityWordCanonical(match[1], match[2]); return match.index === undefined || canonical === null ? [] : [{ start: match.index, end: match.index + match[0].length, form: match[0], canonical }]; });
  const claims: NumericClaim[] = dates.map((date) => ({ normalizedValue: date.canonical, observedForm: date.form, canonicalValue: date.canonical, claimType: "date", sourceStage, sourceField, ...context(text, date.start, date.end) }));
  for (const match of text.matchAll(nominalPattern)) if (match.index !== undefined) claims.push({ normalizedValue: normalizeNominal(match[0]), observedForm: match[0], canonicalValue: normalizeNominal(match[0]), claimType: match[0].includes(".") ? "model_version" : "nominal_identifier", sourceStage, sourceField, ...context(text, match.index, match.index + match[0].length) });
  for (const quantity of wordQuantities) claims.push({ normalizedValue: quantity.canonical, observedForm: quantity.form, canonicalValue: quantity.canonical, claimType: "quantity", sourceStage, sourceField, ...context(text, quantity.start, quantity.end) });
  for (const match of text.matchAll(numericPattern)) {
    if (match.index === undefined) continue; const start = match.index; const end = start + match[0].length; if (isInside(start, end, ranges) || dates.some((date) => start >= date.start && end <= date.end) || wordQuantities.some((quantity) => start >= quantity.start && end <= quantity.end)) continue;
    const form = match[0]; const ctx = context(text, start, end); const compact = form.replace(/[ \u00A0\u202F\u2009]/g, ""); const groupedQuantity = /[ \u00A0\u202F\u2009]/.test(form) && /^\d{1,3}(?:[ \u00A0\u202F\u2009]\d{3})+$/.test(form); const percentage = /%$/.test(compact); const currency = /^[\$€£]/.test(compact); const suffix = /([KMB])$/i.exec(compact)?.[1]; const bare = compact.replace(/%$/, "").replace(/^[\$€£]/, "").replace(/[KMB]$/i, ""); const year = /^\d{4}$/.test(bare) && Number(bare) >= 1900 && Number(bare) <= 2100; const contextualQuantity = quantityWords.test(ctx.before) || quantityWords.test(ctx.after); const claimType: NumericClaimType = percentage ? "percentage" : currency ? "currency" : suffix || groupedQuantity || contextualQuantity ? "quantity" : year ? "year" : "unknown_numeric"; const canonical = percentage ? canonicalNumber(parseLocaleNumber(bare) ?? Number.NaN) : currency ? `${compact[0]}:${quantityCanonical(bare) ?? ""}` : quantityCanonical(bare, suffix) ?? null;
    claims.push({ normalizedValue: canonical ?? normalizeText(form), observedForm: form, canonicalValue: canonical, claimType, sourceStage, sourceField, ...ctx });
  }
  return claims;
}
function inputNumericClaims(input: EditorInput): NumericClaim[] { return [claimsFromText(input.event.canonicalTitle, "event", "event.canonicalTitle"), claimsFromText(input.translation.translatedTitle, "translation", "translation.translatedTitle"), claimsFromText(input.translation.translatedSourceMaterial, "translation", "translation.translatedSourceMaterial"), ...input.translation.translatedFacts.map((fact, index) => claimsFromText(fact.translatedText, "translation", `translation.translatedFacts[${index}].translatedText`)), ...input.verification.verifiedFacts.map((fact, index) => claimsFromText(fact.claim, "verification", `verification.verifiedFacts[${index}].claim`)), ...input.verification.uncertainClaims.map((claim, index) => claimsFromText(claim.claim, "verification", `verification.uncertainClaims[${index}].claim`))].flat(); }
function draftNumericClaims(draft: EditorialDraft): NumericClaim[] { return [claimsFromText(draft.headlineEs, "draft", "headlineEs"), claimsFromText(draft.dekEs, "draft", "dekEs"), claimsFromText(draft.summaryEs, "draft", "summaryEs"), claimsFromText(draft.whyItMattersEs, "draft", "whyItMattersEs"), claimsFromText(draft.bodyEs, "draft", "bodyEs"), ...draft.keyPoints.map((point, index) => claimsFromText(point, "draft", `keyPoints[${index}]`))].flat(); }
export function analyzeEditorialNumericClaims(input: EditorInput, draft: EditorialDraft): NumericGuardReport {
  const detectedNumericClaims = draftNumericClaims(draft); const allowedNumericClaims = inputNumericClaims(input); const matchedProvenance: MatchedNumericProvenance[] = []; const rejectedNumericClaims: NumericClaim[] = [];
  for (const output of detectedNumericClaims) { const match = allowedNumericClaims.find((candidate) => { if (candidate.claimType !== output.claimType || candidate.canonicalValue === null || output.canonicalValue === null) return false; if (candidate.canonicalValue === output.canonicalValue) return true; return output.claimType === "date" && output.canonicalValue.startsWith("--") && candidate.canonicalValue.endsWith(output.canonicalValue.slice(1)); }); if (!match) rejectedNumericClaims.push(output); else matchedProvenance.push({ outputObservedForm: output.observedForm, outputCanonicalValue: output.canonicalValue ?? "", inputObservedForm: match.observedForm, inputCanonicalValue: match.canonicalValue ?? "", claimType: output.claimType, sourceStage: match.sourceStage as "event" | "translation" | "verification", sourceField: match.sourceField, matchReason: output.claimType === "date" ? "exact_date_normalization" : output.claimType === "quantity" && output.observedForm.toLocaleLowerCase() !== match.observedForm.toLocaleLowerCase() ? "exact_quantity_normalization" : output.observedForm.toLocaleLowerCase() !== match.observedForm.toLocaleLowerCase() ? "exact_suffix_normalization" : "exact_canonical_value" }); }
  return { detectedNumericClaims, allowedNumericClaims, rejectedNumericClaims, matchedProvenance, provenance: [...allowedNumericClaims, ...rejectedNumericClaims] };
}
export function numericGuardDiagnostics(report: NumericGuardReport): ProviderDiagnostics {
  const rejected = report.rejectedNumericClaims[0];
  const exactNormalizedMatches = rejected
    ? report.allowedNumericClaims.filter((candidate) => candidate.normalizedValue === rejected.normalizedValue).slice(0, 10).map((candidate) => ({ normalizedValue: candidate.normalizedValue, sourceStage: candidate.sourceStage, sourceField: candidate.sourceField }))
    : [];
  const draftContext = rejected
    ? normalizeText(`${rejected.contextBefore ?? ""}${rejected.observedForm}${rejected.contextAfter ?? ""}`).slice(0, 80)
    : "";
  return {
    guardFailureType: "NUMERIC_UNSUPPORTED_TOKEN",
    failureReasonCode: "NUMERIC_UNSUPPORTED_TOKEN",
    rejectedNumericClaims: report.rejectedNumericClaims,
    rejectedToken: rejected?.observedForm,
    normalizedToken: rejected?.normalizedValue,
    tokenType: rejected?.claimType,
    draftField: rejected?.sourceField,
    draftContext,
    allowedNumericClaimCount: report.allowedNumericClaims.length,
    rejectedNumericClaimCount: report.rejectedNumericClaims.length,
    closestExactNormalizedMatches: exactNormalizedMatches,
    provenanceSourcesChecked: [...new Set(report.allowedNumericClaims.map((candidate) => candidate.sourceField))].slice(0, 50),
    matchedNumericProvenance: report.matchedProvenance,
  };
}
