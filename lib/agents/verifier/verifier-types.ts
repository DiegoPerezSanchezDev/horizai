import { z } from "zod";
import { clusteredEventSchema, extractedItemSchema } from "../contracts/index.ts";

const httpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), "URL must use http or https");
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const languageCode = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);

export const verifierSourceMetadataSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceName: z.string().trim().min(1).max(200),
    sourceUrl: httpUrl,
    sourceType: z.string().trim().min(1).max(80).nullable().optional(),
    countryCode: countryCode.nullable().optional(),
    language: languageCode.nullable().optional(),
  })
  .strict();

export type VerifierSourceMetadata = z.infer<typeof verifierSourceMetadataSchema>;

export const verifierInputSchema = z
  .object({
    event: clusteredEventSchema,
    items: z.array(extractedItemSchema).min(1).max(100),
    sources: z.array(verifierSourceMetadataSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const itemIds = new Set(value.items.map((item) => item.candidateId));
    for (const sourceItem of value.event.sourceItems) {
      if (!itemIds.has(sourceItem.candidateId)) {
        context.addIssue({ code: "custom", path: ["items"], message: `Missing extracted item ${sourceItem.candidateId}` });
      }
    }
  });

export type VerifierInput = z.infer<typeof verifierInputSchema>;
