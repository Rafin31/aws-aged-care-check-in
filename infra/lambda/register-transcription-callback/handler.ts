import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  registerTranscriptionCallbackInputSchema,
  type RegisterTranscriptionCallbackInput,
} from './schema';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CALLBACK_TTL_SECONDS = 60 * 60;

export async function handler(event: RegisterTranscriptionCallbackInput): Promise<void> {
  const input = registerTranscriptionCallbackInputSchema.parse(event);

  await ddbClient.send(
    new PutCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Item: {
        callbackId: input.transcriptionJobName,
        taskToken: input.taskToken,
        expiresAt: Math.floor(Date.now() / 1000) + CALLBACK_TTL_SECONDS,
      },
    }),
  );
}
