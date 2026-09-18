import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const snsMock = mockClient(SNSClient);

beforeEach(() => {
  snsMock.reset();
  process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:111111111111:alert-topic';
});

test('publishes a distress alert to the SNS topic', async () => {
  snsMock.on(PublishCommand).resolves({});

  await handler({ personId: 'person-1', summary: 'Mentioned falling this morning.', sentiment: 'negative' });

  const calls = snsMock.commandCalls(PublishCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.TopicArn).toBe(process.env.ALERT_TOPIC_ARN);
  expect(calls[0].args[0].input.Message).toContain('Mentioned falling this morning.');
  expect(calls[0].args[0].input.Subject).toContain('person-1');
});
