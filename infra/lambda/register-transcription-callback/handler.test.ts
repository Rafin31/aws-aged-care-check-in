import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('stores the task token under the transcription job name', async () => {
  ddbMock.on(PutCommand).resolves({});

  await handler({ transcriptionJobName: 'job-123', taskToken: 'token-xyz' });

  const calls = ddbMock.commandCalls(PutCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.Item).toMatchObject({
    callbackId: 'job-123',
    taskToken: 'token-xyz',
  });
});
