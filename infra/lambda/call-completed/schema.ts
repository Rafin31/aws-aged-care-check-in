import { z } from 'zod';

export const callCompletedInputSchema = z.object({
  contactId: z.string().min(1),
  recordingS3Uri: z.string().url(),
});

export type CallCompletedInput = z.infer<typeof callCompletedInputSchema>;
