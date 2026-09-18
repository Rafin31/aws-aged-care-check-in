import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { TranscribeClient, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';

const transcribeMock = mockClient(TranscribeClient);
const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

beforeEach(() => {
  transcribeMock.reset();
  s3Mock.reset();
  ddbMock.reset();
  sfnMock.reset();
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('extracts the transcript and resumes the paused task', async () => {
  transcribeMock.on(GetTranscriptionJobCommand).resolves({
    TranscriptionJob: {
      Transcript: { TranscriptFileUri: 'https://bucket.s3.ap-southeast-2.amazonaws.com/output/job-123.json' },
    },
  });
  const transcriptJson = JSON.stringify({ results: { transcripts: [{ transcript: "I'm doing okay today." }] } });
  s3Mock.on(GetObjectCommand).resolves({
    Body: sdkStreamMixin(Readable.from([Buffer.from(transcriptJson)])),
  });
  ddbMock.on(GetCommand).resolves({ Item: { callbackId: 'job-123', taskToken: 'token-xyz' } });
  sfnMock.on(SendTaskSuccessCommand).resolves({});

  await handler({
    detail: { TranscriptionJobName: 'job-123', TranscriptionJobStatus: 'COMPLETED' },
  });

  const calls = sfnMock.commandCalls(SendTaskSuccessCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.taskToken).toBe('token-xyz');
  expect(JSON.parse(calls[0].args[0].input.output as string)).toEqual({
    transcript: "I'm doing okay today.",
  });
});
