import { z } from 'zod';

export const analyzeResponseInputSchema = z.object({
  transcript: z.string(),
});
export type AnalyzeResponseInput = z.infer<typeof analyzeResponseInputSchema>;

export const analyzeResponseOutputSchema = z.object({
  responded: z.boolean(),
  distressDetected: z.boolean(),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  summary: z.string(),
});
export type AnalyzeResponseOutput = z.infer<typeof analyzeResponseOutputSchema>;
