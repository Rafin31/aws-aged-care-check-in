import { ConnectClient, DescribeContactCommand } from '@aws-sdk/client-connect';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { callCompletedInputSchema, type CallCompletedInput } from './schema';

const connectClient = new ConnectClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfnClient = new SFNClient({});

export async function handler(event: CallCompletedInput): Promise<void> {
  const input = callCompletedInputSchema.parse(event);
  const { contactId, instanceArn } = input.detail;

  // The DISCONNECTED event fires the instant the call ends, but the
  // finished recording can take a few seconds longer to be reflected in
  // DescribeContact. Throwing here (rather than treating an empty
  // Recordings list as permanent) lets EventBridge's built-in retry
  // policy on the Lambda target re-invoke us shortly after, instead of
  // this Lambda polling internally.
  const { Contact } = await connectClient.send(
    new DescribeContactCommand({ InstanceId: instanceArn, ContactId: contactId }),
  );
  const recordingS3Uri = Contact?.Recordings?.[0]?.Location;
  if (!recordingS3Uri) {
    throw new Error(`No recording location available yet for contact ${contactId}`);
  }

  const { Item } = await ddbClient.send(
    new GetCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Key: { callbackId: contactId },
    }),
  );

  if (!Item) {
    throw new Error(`No callback token found for contact ${contactId}`);
  }

  await sfnClient.send(
    new SendTaskSuccessCommand({
      taskToken: Item.taskToken as string,
      output: JSON.stringify({ recordingS3Uri }),
    }),
  );
}
