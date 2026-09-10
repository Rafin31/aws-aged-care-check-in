import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('resumes the paused Step Functions task with the recording location', async () => {
  ddbMock.on(GetCommand).resolves({ Item: { callbackId: 'contact-123', taskToken: 'token-abc' } });
  sfnMock.on(SendTaskSuccessCommand).resolves({});

  await handler({ contactId: 'contact-123', recordingS3Uri: 's3://bucket/call-recordings/contact-123.wav' });

  const calls = sfnMock.commandCalls(SendTaskSuccessCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.taskToken).toBe('token-abc');
  expect(JSON.parse(calls[0].args[0].input.output as string)).toEqual({
    recordingS3Uri: 's3://bucket/call-recordings/contact-123.wav',
  });
});

test('throws if no callback token is on file for the contact', async () => {
  ddbMock.on(GetCommand).resolves({ Item: undefined });

  await expect(
    handler({ contactId: 'unknown-contact', recordingS3Uri: 's3://bucket/x.wav' }),
  ).rejects.toThrow('No callback token found');
});
