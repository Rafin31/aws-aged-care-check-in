import { z } from 'zod';

export const callCompletedInputSchema = z.object({
  detail: z.object({
    eventType: z.literal('DISCONNECTED'),
    contactId: z.string().min(1),
    instanceArn: z.string().min(1),
  }),
});

export type CallCompletedInput = z.infer<typeof callCompletedInputSchema>;
