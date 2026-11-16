import type { CriticInput } from "./critic-types.ts";
import { criticGenerationV3Schema } from "./critic-types.ts";
import { buildCriticModelInput, buildCriticModelInputV3 } from "./critic-input.ts";
import { criticSystemInstructions, criticV3SystemInstructions } from "./critic-prompt.ts";
import { toStrictProviderJsonSchema } from "../runtime/strict-json-schema.ts";
import { estimateGroqStageTokenRequirement } from "../runtime/groq-capacity-pacing.ts";

export type CriticRequestEstimate = ReturnType<typeof estimateGroqStageTokenRequirement> & {
  systemInstructionChars: number;
  modelInputChars: number;
  schemaChars: number;
};

function estimate(systemInstructions: string, modelInput: unknown, maxOutputTokens = 1_200): CriticRequestEstimate {
  const systemInstructionChars = systemInstructions.length;
  const modelInputChars = JSON.stringify(modelInput).length;
  const schemaChars = JSON.stringify(toStrictProviderJsonSchema(criticGenerationV3Schema)).length;
  return {
    ...estimateGroqStageTokenRequirement({ systemInstructionChars, modelInputChars, schemaChars, maxOutputTokens }),
    systemInstructionChars,
    modelInputChars,
    schemaChars,
  };
}

export function estimateCriticV4Request(input: CriticInput, maxOutputTokens = 1_200): CriticRequestEstimate {
  return estimate(criticSystemInstructions, buildCriticModelInput(input).input, maxOutputTokens);
}

/** Reconstructs the exact frozen v3 request for offline historical comparison. */
export function estimateCriticV3Request(input: CriticInput, maxOutputTokens = 1_200): CriticRequestEstimate {
  return estimate(criticV3SystemInstructions, buildCriticModelInputV3(input).input, maxOutputTokens);
}
