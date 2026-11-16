/** Model-backed stages in one normal event. Geo resolution is intentionally deterministic and excluded. */
export const normalEventStages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
export type NormalEventStage = (typeof normalEventStages)[number];
