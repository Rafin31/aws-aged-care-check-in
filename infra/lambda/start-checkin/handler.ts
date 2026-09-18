import { ConnectClient, StartOutboundVoiceContactCommand } from '@aws-sdk/client-connect';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { startCheckinInputSchema, type StartCheckinInput } from './schema';

const connectClient = new ConnectClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Callback rows expire after 1 hour — plenty for a call to connect and
// end, short enough that an abandoned call doesn't leave a stale row.
const CALLBACK_TTL_SECONDS = 60 * 60;

export async function handler(event: StartCheckinInput): Promise<void> {
  const input = startCheckinInputSchema.parse(event);

  const { ContactId } = await connectClient.send(
    new StartOutboundVoiceContactCommand({
      DestinationPhoneNumber: input.phoneNumber,
      // Lambda functions get env vars from the CDK stack, set at deploy time.
      ContactFlowId: process.env.CONNECT_CONTACT_FLOW_ID,
      InstanceId: process.env.CONNECT_INSTANCE_ARN,
      SourcePhoneNumber: process.env.CONNECT_SOURCE_PHONE_NUMBER,
      Attributes: { personId: input.personId },
    }),
  );

  if (!ContactId) {
    throw new Error('Connect did not return a contact ID for the outbound call');
  }

  await ddbClient.send(
    new PutCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Item: {
        callbackId: ContactId,
        taskToken: input.taskToken,
        expiresAt: Math.floor(Date.now() / 1000) + CALLBACK_TTL_SECONDS,
      },
    }),
  );
}
