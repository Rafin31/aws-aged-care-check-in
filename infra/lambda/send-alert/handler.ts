import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { sendAlertInputSchema, type SendAlertInput } from './schema';

const snsClient = new SNSClient({});

export async function handler(event: SendAlertInput): Promise<void> {
  const input = sendAlertInputSchema.parse(event);

  await snsClient.send(
    new PublishCommand({
      TopicArn: process.env.ALERT_TOPIC_ARN,
      Subject: `Check-in alert for ${input.personId}`,
      Message: `Sentiment: ${input.sentiment}\n\n${input.summary}`,
    }),
  );
}
