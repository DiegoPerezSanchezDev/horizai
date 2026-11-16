export const rankerQaDimensions = [
  "IMPACT_ACCURACY",
  "NOVELTY_ACCURACY",
  "REACH_ACCURACY",
  "CREDIBILITY_ACCURACY",
  "ECONOMIC_IMPACT_ACCURACY",
  "MOMENTUM_ACCURACY",
  "FINAL_SCORE_REASONABLENESS",
  "NO_VIRALITY_OVERRIDES_CREDIBILITY",
  "NO_GLOBAL_BIAS",
  "NO_INVENTED_RATIONALE",
] as const;

export type RankerQaDimension = (typeof rankerQaDimensions)[number];
export type RankerQaStatus = "PASS" | "WARNING" | "FAIL";
