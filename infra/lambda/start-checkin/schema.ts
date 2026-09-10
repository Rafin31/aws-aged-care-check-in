import { z } from 'zod';

export const startCheckinInputSchema = z.object({
  personId: z.string().min(1),
  phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'must be E.164 format'),
  taskToken: z.string().min(1),
});

export type StartCheckinInput = z.infer<typeof startCheckinInputSchema>;
