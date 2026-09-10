import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { callCompletedInputSchema, type CallCompletedInput } from './schema';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfnClient = new SFNClient({});

export async function handler(event: CallCompletedInput): Promise<void> {
  const input = callCompletedInputSchema.parse(event);

  const { Item } = await ddbClient.send(
    new GetCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Key: { callbackId: input.contactId },
    }),
  );

  if (!Item) {
    throw new Error(`No callback token found for contact ${input.contactId}`);
  }

  await sfnClient.send(
    new SendTaskSuccessCommand({
      taskToken: Item.taskToken as string,
      output: JSON.stringify({ recordingS3Uri: input.recordingS3Uri }),
    }),
  );
}
