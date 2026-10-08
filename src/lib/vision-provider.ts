import './env.ts';
import { ensure } from './validation.ts';

// Provider transport is isolated from report interpretation and scoring.
export async function requestVision(
  image: Buffer,
  mimeType: string,
  system: string,
  instructions: string,
): Promise<unknown> {
  const base = process.env.VISION_BASE_URL,
    model = process.env.VISION_MODEL;
  ensure(base && model, 'Set VISION_BASE_URL and VISION_MODEL before uploading reports.');
  const trimmed = base.replace(/\/+$/, '');
  const apiKey = process.env.VISION_API_KEY || process.env.OPENAI_API_KEY;
  const response = await fetch(
    trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: instructions },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${image.toString('base64')}` },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      }),
    },
  );
  ensure(response.ok, `Vision provider returned HTTP ${response.status}. No report was saved.`);
  const body = await response.json(),
    choice = body.choices?.[0];
  ensure(
    choice?.finish_reason === 'stop' && !choice.message?.refusal,
    'Vision could not finish reading the report. No report was saved.',
  );
  ensure(typeof choice.message.content === 'string', 'Vision returned an invalid response.');
  let result;
  try {
    result = JSON.parse(choice.message.content);
  } catch {
    throw new Error('Vision did not return valid JSON. No report was saved.');
  }
  ensure(
    result && typeof result === 'object' && !Array.isArray(result),
    'Vision returned an invalid report.',
  );
  return result;
}
