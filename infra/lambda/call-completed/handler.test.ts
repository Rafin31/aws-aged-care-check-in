import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { ConnectClient, DescribeContactCommand } from '@aws-sdk/client-connect';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';

const connectMock = mockClient(ConnectClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

const instanceArn = 'arn:aws:connect:ap-southeast-2:111111111111:instance/test-instance';

beforeEach(() => {
  connectMock.reset();
  ddbMock.reset();
  sfnMock.reset();
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('resumes the paused Step Functions task with the recording location', async () => {
  connectMock.on(DescribeContactCommand).resolves({
    Contact: { Recordings: [{ Location: 's3://bucket/call-recordings/contact-123.wav' }] },
  });
  ddbMock.on(GetCommand).resolves({ Item: { callbackId: 'contact-123', taskToken: 'token-abc' } });
  sfnMock.on(SendTaskSuccessCommand).resolves({});

  await handler({ detail: { eventType: 'DISCONNECTED', contactId: 'contact-123', instanceArn } });

  const describeCalls = connectMock.commandCalls(DescribeContactCommand);
  expect(describeCalls[0].args[0].input).toEqual({ InstanceId: instanceArn, ContactId: 'contact-123' });

  const calls = sfnMock.commandCalls(SendTaskSuccessCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.taskToken).toBe('token-abc');
  expect(JSON.parse(calls[0].args[0].input.output as string)).toEqual({
    recordingS3Uri: 's3://bucket/call-recordings/contact-123.wav',
  });
});

test('throws if the recording is not available yet', async () => {
  connectMock.on(DescribeContactCommand).resolves({ Contact: { Recordings: [] } });

  await expect(
    handler({ detail: { eventType: 'DISCONNECTED', contactId: 'contact-123', instanceArn } }),
  ).rejects.toThrow('No recording location available yet');
  expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
});

test('throws if no callback token is on file for the contact', async () => {
  connectMock.on(DescribeContactCommand).resolves({
    Contact: { Recordings: [{ Location: 's3://bucket/x.wav' }] },
  });
  ddbMock.on(GetCommand).resolves({ Item: undefined });

  await expect(
    handler({ detail: { eventType: 'DISCONNECTED', contactId: 'unknown-contact', instanceArn } }),
  ).rejects.toThrow('No callback token found');
});
