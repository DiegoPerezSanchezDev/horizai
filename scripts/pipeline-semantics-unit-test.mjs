import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const classifierSource = await readFile("scripts/classifier-test.ts", "utf8");
const rankerSource = await readFile("scripts/ranker-test.ts", "utf8");
assert.match(classifierSource, /SKIPPED_VERIFICATION_INSUFFICIENT/);
assert.match(classifierSource, /translator_precondition_failed/);
assert.match(rankerSource, /classifierExit === 2/);
assert.match(rankerSource, /SKIPPED_VERIFICATION_INSUFFICIENT/);
assert.match(rankerSource, /classifierExit !== 0/);
console.log("Pipeline status semantics fixtures passed");
