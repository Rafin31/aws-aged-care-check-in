import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
});

function mockBedrockReply(json: unknown) {
  const body = {
    content: [{ type: 'text', text: JSON.stringify(json) }],
  };
  bedrockMock.on(InvokeModelCommand).resolves({
    body: new TextEncoder().encode(JSON.stringify(body)),
  } as never);
}

test('returns a validated distress verdict for a normal response', async () => {
  mockBedrockReply({
    responded: true,
    distressDetected: false,
    sentiment: 'positive',
    summary: 'Person sounded well and mentioned going for a walk.',
  });

  const result = await handler({ transcript: "I'm doing great today, thanks for calling." });

  expect(result).toEqual({
    responded: true,
    distressDetected: false,
    sentiment: 'positive',
    summary: 'Person sounded well and mentioned going for a walk.',
  });
});

test('throws if the model reply does not match the expected shape', async () => {
  mockBedrockReply({ responded: true }); // missing required fields

  await expect(handler({ transcript: 'garbled response' })).rejects.toThrow();
});
