/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, test } from 'vitest';
import { OpenAiResponses } from './openai-responses';

describe('OpenAiResponses', () => {
  const provider = new OpenAiResponses('gpt-test', 'test-key');

  test('extractDeltaOutput handles null and undefined', () => {
    const nullDelta = { type: 'response.output_text.delta', delta: null };
    const undefinedDelta = { type: 'response.output_text.delta' };
    expect(provider.extractDeltaOutput(nullDelta)).toBe('');
    expect(provider.extractDeltaOutput(undefinedDelta)).toBe('');
  });

  test('extractOutput returns text from response body', () => {
    const withOutputText = { id: '1', output_text: 'hello', usage: {}, output: [] };
    expect(provider.extractOutput(withOutputText)).toEqual(['hello']);

    const withContentArray = {
      id: '2',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'from content' }],
        },
      ],
    };
    expect(provider.extractOutput(withContentArray)).toEqual(['from content']);
  });

  test('extractTokenUsage fills in defaults', () => {
    expect(
      provider.extractTokenUsage({
        id: '3',
        output_text: '',
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }),
    ).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5, costDollars: undefined });

    expect(provider.extractTokenUsage({ id: '4', output_text: '' })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costDollars: undefined,
    });
  });
});
