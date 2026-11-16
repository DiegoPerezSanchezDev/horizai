import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalCriticInput } from "../lib/agents/critic/critic-fixtures.ts";
import { buildRankerPipelineCheckpoint, parseSafeRankerPipelineCheckpoint, readSafeRankerPipelineCheckpoint, writeRankerPipelineCheckpointAtomic } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";

const { ranking, ...beforeRanking } = canonicalCriticInput;
const checkpoint = buildRankerPipelineCheckpoint(beforeRanking, ranking, "2026-09-15T10:00:00.000Z");
assert.equal(checkpoint.eventKey, canonicalCriticInput.event.eventKey);
assert.doesNotThrow(() => parseSafeRankerPipelineCheckpoint(JSON.stringify(checkpoint)));
assert.throws(() => parseSafeRankerPipelineCheckpoint(JSON.stringify({ ...checkpoint, raw_content: "forbidden" })), /prohibited fields/);
assert.throws(() => parseSafeRankerPipelineCheckpoint(JSON.stringify({ ...checkpoint, editorial: { ...checkpoint.editorial, reasoning: "forbidden" } })), /prohibited fields/);
assert.throws(() => parseSafeRankerPipelineCheckpoint(JSON.stringify({ ...checkpoint, eventKey: "different" })), /identifiers/);

const root = await mkdtemp(join(tmpdir(), "horizai-critic-checkpoint-"));
try {
  const target = join(root, "pipeline-ranker-checkpoint.json");
  const written = await writeRankerPipelineCheckpointAtomic(checkpoint, target);
  assert.ok(written.bytes > 0);
  const loaded = await readSafeRankerPipelineCheckpoint(target);
  assert.equal(loaded.ranking.result.eventKey, checkpoint.eventKey);
  assert.equal(loaded.editorial.eventKey, checkpoint.eventKey);
  await assert.rejects(access(`${target}.tmp`));
  const raw = await readFile(target, "utf8");
  assert.doesNotMatch(raw, /"(?:html|raw_content|api[_-]?key|authorization|prompt|reasoning|chainofthought)"\s*:/i);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Critic checkpoint fixtures passed");
