import { z } from 'zod';

export const transcribeJobStateChangeSchema = z.object({
  detail: z.object({
    TranscriptionJobName: z.string().min(1),
    TranscriptionJobStatus: z.literal('COMPLETED'),
  }),
});

export type TranscribeJobStateChangeEvent = z.infer<typeof transcribeJobStateChangeSchema>;
