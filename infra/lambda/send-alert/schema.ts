import { z } from 'zod';

export const sendAlertInputSchema = z.object({
  personId: z.string().min(1),
  summary: z.string().min(1),
  sentiment: z.string().min(1),
});
export type SendAlertInput = z.infer<typeof sendAlertInputSchema>;
