import { z } from 'zod';

export const registerTranscriptionCallbackInputSchema = z.object({
  transcriptionJobName: z.string().min(1),
  taskToken: z.string().min(1),
});

export type RegisterTranscriptionCallbackInput = z.infer<
  typeof registerTranscriptionCallbackInputSchema
>;
