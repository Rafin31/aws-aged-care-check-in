import { TranscribeClient, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import {
  transcribeJobStateChangeSchema,
  type TranscribeJobStateChangeEvent,
} from './schema';

const transcribeClient = new TranscribeClient({});
const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfnClient = new SFNClient({});

interface TranscribeOutput {
  results: { transcripts: Array<{ transcript: string }> };
}

export async function handler(event: TranscribeJobStateChangeEvent): Promise<void> {
  const input = transcribeJobStateChangeSchema.parse(event);
  const jobName = input.detail.TranscriptionJobName;

  const { TranscriptionJob } = await transcribeClient.send(
    new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
  );
  const transcriptUri = TranscriptionJob?.Transcript?.TranscriptFileUri;
  if (!transcriptUri) {
    throw new Error(`Transcribe job ${jobName} has no transcript file URI`);
  }

  const url = new URL(transcriptUri);
  const bucket = url.hostname.split('.')[0];
  const key = decodeURIComponent(url.pathname.slice(1));

  const { Body } = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bodyText = await Body?.transformToString();
  if (!bodyText) {
    throw new Error(`Transcript body for job ${jobName} was empty`);
  }
  const parsed = JSON.parse(bodyText) as TranscribeOutput;
  const transcript = parsed.results.transcripts[0]?.transcript ?? '';

  const { Item } = await ddbClient.send(
    new GetCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Key: { callbackId: jobName },
    }),
  );
  if (!Item) {
    throw new Error(`No callback token found for transcription job ${jobName}`);
  }

  await sfnClient.send(
    new SendTaskSuccessCommand({
      taskToken: Item.taskToken as string,
      output: JSON.stringify({ transcript }),
    }),
  );
}
