import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  analyzeResponseInputSchema,
  analyzeResponseOutputSchema,
  type AnalyzeResponseInput,
  type AnalyzeResponseOutput,
} from './schema';
import { SYSTEM_PROMPT } from './prompt';

const bedrockClient = new BedrockRuntimeClient({});
// Claude 3 Haiku is retired from the model catalog; Haiku 4.5 is cross-region-only,
// so this must be the inference profile ID, not a bare model ID.
const MODEL_ID = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

export async function handler(event: AnalyzeResponseInput): Promise<AnalyzeResponseOutput> {
  const input = analyzeResponseInputSchema.parse(event);

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Transcript: "${input.transcript}"` }],
      }),
    }),
  );

  const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = responseBody.content.find((block) => block.type === 'text')?.text;
  if (!text) {
    throw new Error('Bedrock response contained no text content block');
  }

  return analyzeResponseOutputSchema.parse(JSON.parse(text));
}
