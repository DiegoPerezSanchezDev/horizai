import { basename, resolve, sep } from "node:path";
import type { ClusterRunResult } from "../clustering/cluster-types.ts";
import type { DiscoveryRunResult } from "../discovery/discovery-types.ts";
import type { ExtractionRunResult } from "../extraction/extraction-types.ts";
import type { PipelineStages } from "./pipeline-types.ts";
import type { SupervisedCandidateSnapshot } from "./supervised-candidate-snapshot.ts";

export function resolveApprovedSupervisedSnapshotPath(args: readonly string[], approvedSnapshotId: string, root = "artifacts/supervised-candidates"): string {
  if (args.length !== 1 || !args[0].startsWith("--snapshot=")) throw new Error("SNAPSHOT_PATH_REQUIRED; EVENT_KEY_ARGUMENTS_ARE_NOT_ACCEPTED");
  const supplied = args[0].slice("--snapshot=".length);
  if (!supplied || supplied.includes("\0")) throw new Error("INVALID_SNAPSHOT_PATH");
  const expectedRoot = resolve(root);
  const absolutePath = resolve(supplied);
  const relative = absolutePath.slice(expectedRoot.length);
  if (!absolutePath.startsWith(expectedRoot + sep) || basename(absolutePath) !== approvedSnapshotId + ".json" || relative !== sep + approvedSnapshotId + ".json") {
    throw new Error("SNAPSHOT_PATH_NOT_AUTHORIZED");
  }
  return absolutePath;
}

export function createSupervisedSnapshotStages(input: {
  snapshot: SupervisedCandidateSnapshot;
  discovery: DiscoveryRunResult;
  extraction: ExtractionRunResult;
  clustering: ClusterRunResult;
}): Pick<PipelineStages, "discovery" | "extraction" | "clustering"> {
  const expectedSourceItemIds = input.snapshot.sourceItemIds.toSorted();
  const discoveredIds = input.discovery.candidates.map((item) => item.externalId).toSorted();
  const extractedIds = input.extraction.results.filter((item) => item.item).map((item) => item.candidate.externalId).toSorted();
  const clustered = input.clustering.events.filter((event) => event.eventKey === input.snapshot.eventKey);
  if (discoveredIds.length !== expectedSourceItemIds.length || discoveredIds.some((id, index) => id !== expectedSourceItemIds[index])) throw new Error("SUPERVISED_DISCOVERY_IDENTITY_MISMATCH");
  if (extractedIds.length !== expectedSourceItemIds.length || extractedIds.some((id, index) => id !== expectedSourceItemIds[index])) throw new Error("SUPERVISED_EXTRACTION_IDENTITY_MISMATCH");
  if (clustered.length !== 1 || clustered[0].canonicalTitle !== input.snapshot.title) throw new Error("SUPERVISED_CLUSTER_EVENT_MISMATCH");
  const clusterIds = clustered[0].sourceItems.map((item) => item.candidateId).toSorted();
  if (clusterIds.length !== expectedSourceItemIds.length || clusterIds.some((id, index) => id !== expectedSourceItemIds[index])) throw new Error("SUPERVISED_CLUSTER_SOURCE_IDENTITY_MISMATCH");
  return {
    async discovery({ config }) {
      if (config.limit !== 1 || config.hours !== input.snapshot.hours) throw new Error("SUPERVISED_PIPELINE_CONFIG_MISMATCH");
      return input.discovery;
    },
    async extraction() { return input.extraction; },
    async clustering() { return input.clustering; },
  };
}
