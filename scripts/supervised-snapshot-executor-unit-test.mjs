import assert from "node:assert/strict";
import { resolveApprovedSupervisedSnapshotPath, createSupervisedSnapshotStages } from "../lib/agents/pipeline/supervised-snapshot-execution.ts";
import { readSupervisedCandidateSnapshot } from "../lib/agents/pipeline/supervised-candidate-snapshot.ts";

const snapshot = await readSupervisedCandidateSnapshot("artifacts/supervised-candidates/b6f66b19-1281-406c-9bdd-0fdb18b46d08.json");
const snapshotPath = "artifacts/supervised-candidates/b6f66b19-1281-406c-9bdd-0fdb18b46d08.json";
assert.match(resolveApprovedSupervisedSnapshotPath(["--snapshot=" + snapshotPath], snapshot.snapshotId), /b6f66b19-1281-406c-9bdd-0fdb18b46d08\.json$/);
assert.throws(() => resolveApprovedSupervisedSnapshotPath(["--event-key=" + snapshot.eventKey], snapshot.snapshotId), /SNAPSHOT_PATH_REQUIRED/);
assert.throws(() => resolveApprovedSupervisedSnapshotPath(["--snapshot=artifacts/supervised-candidates/other.json"], snapshot.snapshotId), /SNAPSHOT_PATH_NOT_AUTHORIZED/);
console.log("PASS approved snapshot path only; free-form eventKey rejected");

const candidate = { externalId: snapshot.sourceItemIds[0] };
const extractedItem = { candidateId: snapshot.sourceItemIds[0] };
const discovery = { candidates: [candidate] };
const extraction = { results: [{ candidate, item: extractedItem }] };
const clusterEvent = { eventKey: snapshot.eventKey, canonicalTitle: snapshot.title, sourceItems: [{ candidateId: snapshot.sourceItemIds[0] }] };
const clustering = { events: [clusterEvent] };
const stages = createSupervisedSnapshotStages({ snapshot, discovery, extraction, clustering });
assert.deepEqual((await stages.discovery({ config: { hours: snapshot.hours, limit: 1 } })).candidates, [candidate]);
assert.deepEqual((await stages.extraction()).results, extraction.results);
assert.deepEqual((await stages.clustering()).events, [clusterEvent]);
assert.throws(() => createSupervisedSnapshotStages({ snapshot, discovery, extraction, clustering: { events: [{ ...clusterEvent, eventKey: "event-00000000000000000000000000000000" }] } }), /SUPERVISED_CLUSTER_EVENT_MISMATCH/);
console.log("PASS product pipeline stages remain bound to snapshot IDs and eventKey");

console.log(JSON.stringify({ status: "SUCCESS", tests: 2, groqCalls: 0 }));
