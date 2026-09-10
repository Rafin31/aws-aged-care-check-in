import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { ConnectClient, StartOutboundVoiceContactCommand } from '@aws-sdk/client-connect';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const connectMock = mockClient(ConnectClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  connectMock.reset();
  ddbMock.reset();
  process.env.CONNECT_INSTANCE_ARN = 'arn:aws:connect:ap-southeast-2:111111111111:instance/test-instance';
  process.env.CONNECT_CONTACT_FLOW_ID = 'test-flow-id';
  process.env.CONNECT_SOURCE_PHONE_NUMBER = '+61400000000';
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('starts the outbound call and stores the callback token', async () => {
  connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: 'contact-123' });
  ddbMock.on(PutCommand).resolves({});

  await handler({ personId: 'person-1', phoneNumber: '+61411111111', taskToken: 'token-abc' });

  const connectCalls = connectMock.commandCalls(StartOutboundVoiceContactCommand);
  expect(connectCalls).toHaveLength(1);
  expect(connectCalls[0].args[0].input).toMatchObject({
    DestinationPhoneNumber: '+61411111111',
    ContactFlowId: 'test-flow-id',
    InstanceId: process.env.CONNECT_INSTANCE_ARN,
    Attributes: { personId: 'person-1' },
  });

  const ddbCalls = ddbMock.commandCalls(PutCommand);
  expect(ddbCalls).toHaveLength(1);
  expect(ddbCalls[0].args[0].input.Item).toMatchObject({
    callbackId: 'contact-123',
    taskToken: 'token-abc',
  });
});

test('rejects an invalid phone number before calling Connect', async () => {
  await expect(
    handler({ personId: 'person-1', phoneNumber: 'not-a-number', taskToken: 'token-abc' }),
  ).rejects.toThrow();
  expect(connectMock.commandCalls(StartOutboundVoiceContactCommand)).toHaveLength(0);
});
