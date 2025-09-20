import {
  normalizedProviderConfigSchema,
  type ConversationPrompt,
  type ModelProvider,
  type PromptPart,
  type RunContext,
  type TokenUsage,
} from '$lib/types';
import { fileToBase64 } from '$lib/utils/media';
import { Semaphore } from '$lib/utils/semaphore';
import { sse } from '$lib/utils/sse';
import { exponentialBackoff, shouldRetryHttpError, HttpError } from '$lib/utils/exponentialBackoff';
import { z } from 'zod';
import { CHROME_CONCURRENT_REQUEST_LIMIT_PER_DOMAIN } from './common';
import { getCost } from './openai';

const OPENAI_RESPONSES_SEMAPHORE = new Semaphore(CHROME_CONCURRENT_REQUEST_LIMIT_PER_DOMAIN);

const responseTextDeltaEventSchema = z.object({
  type: z.literal('response.output_text.delta'),
  delta: z.string().nullish().default(''),
});

const responseRefusalDeltaEventSchema = z.object({
  type: z.literal('response.refusal.delta'),
  delta: z.string().nullish().default(''),
});

const responseCompletedEventSchema = z.object({
  type: z.literal('response.completed'),
  response: z
    .object({
      id: z.string(),
      output_text: z.string().nullish(),
      usage: z
        .object({
          input_tokens: z.number().int().optional(),
          output_tokens: z.number().int().optional(),
          total_tokens: z.number().int().optional(),
        })
        .optional(),
      output: z
        .array(
          z
            .object({
              type: z.string(),
              role: z.string().optional(),
              content: z
                .array(
                  z
                    .object({
                      type: z.string(),
                      text: z.string().optional(),
                    })
                    .passthrough(),
                )
                .optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),
});

const responseErrorEventSchema = z.object({
  type: z.literal('response.error'),
  error: z.object({ message: z.string() }),
});

const responseFailedEventSchema = z.object({
  type: z.literal('response.failed'),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  reason: z.string().optional(),
});

const responseSchema = responseCompletedEventSchema.shape.response;

const configSchema = normalizedProviderConfigSchema
  .extend({
    apiBaseUrl: z.string().optional(),
  })
  .passthrough();

export type OpenAiResponsesConfig = z.infer<typeof configSchema>;

const requestErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
  }),
});

export class OpenAiResponses implements ModelProvider {
  private apiBaseUrl: string;
  private request: object;

  constructor(
    public model: string,
    public apiKey: string,
    config: Record<string, unknown> = {},
    public costFunction: typeof getCost = getCost,
  ) {
    const { apiBaseUrl, mimeTypes, ...request } = configSchema.parse(config);
    if (mimeTypes) {
      this.mimeTypes = mimeTypes;
    }

    this.apiBaseUrl = apiBaseUrl ?? 'https://api.openai.com';
    this.request = request;
  }

  get id(): string {
    return `openai-responses:${this.model}`;
  }

  get requestSemaphore(): Semaphore {
    return OPENAI_RESPONSES_SEMAPHORE;
  }

  mimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  async run(conversation: ConversationPrompt, context: RunContext) {
    const sessionMessages = (context.session?.state ?? []) as ResponseMessage[];
    const newMessages = await conversationToResponses(conversation);
    const messages = mergeMessages(sessionMessages, newMessages);

    const request = {
      model: this.model,
      ...this.request,
      stream: true,
      store: false,
      input: messages.map(({ role, content }) => ({ role, content, type: 'message' as const })),
    } as const;

    const { apiBaseUrl, apiKey } = this;
    const extractDeltaOutput = this.extractDeltaOutput.bind(this);
    const extractRefusalDelta = this.extractRefusalDelta.bind(this);

    return {
      request,
      runModel: async function* () {
        yield '';
        const resp = await exponentialBackoff(
          async () => {
            const resp = await fetch(`${apiBaseUrl}/v1/responses`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(request),
              signal: context.abortSignal,
            });

            if (!resp.ok) {
              let error;
              try {
                const json: unknown = await resp.json();
                error = requestErrorSchema.parse(json);
                throw new HttpError(
                  `Failed to run model: ${error.error.type ?? 'OpenAI error'}: ${error.error.message}`,
                  resp.status,
                );
              } catch (parseError) {
                if (parseError instanceof HttpError) {
                  throw parseError;
                }
                throw new HttpError(`Failed to run model: ${resp.statusText}`, resp.status);
              }
            }
            return resp;
          },
          { shouldRetry: shouldRetryHttpError },
        );

        const stream = resp.body;
        if (!stream) throw new Error(`Failed to run model: no response`);

        let fullText = '';
        let finalResponseJson: unknown;
        for await (const value of sse(resp)) {
          const json = JSON.parse(value);
          switch (json?.type) {
            case 'response.output_text.delta': {
              const text = extractDeltaOutput(json);
              fullText += text;
              yield text;
              break;
            }
            case 'response.refusal.delta': {
              const text = extractRefusalDelta(json);
              fullText += text;
              yield text;
              break;
            }
            case 'response.completed': {
              const completed = responseCompletedEventSchema.parse(json);
              finalResponseJson = completed.response;
              break;
            }
            case 'response.error': {
              const error = responseErrorEventSchema.parse(json);
              throw new Error(`Failed to run model: ${error.error.message}`);
            }
            case 'response.failed': {
              const failed = responseFailedEventSchema.parse(json);
              const message = failed.error?.message ?? failed.reason ?? 'Unknown error';
              throw new Error(`Failed to run model: ${message}`);
            }
            default:
              break;
          }
        }

        if (!finalResponseJson) {
          throw new Error('Failed to run model: missing completion');
        }

        const parsed = responseSchema.parse(finalResponseJson);
        const messageContent = parsed.output_text ?? fullText;
        const message: ResponseMessage = {
          role: 'assistant',
          content: messageContent ?? '',
          type: 'message',
        };

        return {
          response: parsed,
          session: {
            state: [...messages, message] satisfies ResponseMessage[],
          },
        };
      },
    };
  }

  extractDeltaOutput(event: unknown): string {
    const json = responseTextDeltaEventSchema.parse(event);
    return json.delta ?? '';
  }

  extractRefusalDelta(event: unknown): string {
    const json = responseRefusalDeltaEventSchema.parse(event);
    return json.delta ?? '';
  }

  extractOutput(response: unknown): (string | Blob)[] {
    const json = responseSchema.parse(response);
    const directText = json.output_text ?? '';
    if (typeof directText === 'string' && directText.length > 0) {
      return [directText];
    }

    const output = json.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const content of item.content) {
            if (content?.type === 'output_text' && typeof content.text === 'string') {
              return [content.text];
            }
          }
        }
      }
    }

    return [''];
  }

  extractTokenUsage(response: unknown): TokenUsage {
    const json = responseSchema.parse(response);
    const usage = json.usage ?? {};

    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      costDollars: this.costFunction(this.model, inputTokens, outputTokens),
    };
  }
}

type ResponseInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url?: string | null; detail: 'auto' | 'low' | 'high' };

type ResponseMessage = {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponseInputContent[];
  type?: 'message';
};

async function conversationToResponses(conversation: ConversationPrompt): Promise<ResponseMessage[]> {
  return Promise.all(
    conversation.map(async (part): Promise<ResponseMessage> => {
      const content = await Promise.all(part.content.map(multiPartPromptToResponse));
      if (content.length === 1 && content[0]?.type === 'input_text') {
        return { role: part.role, content: content[0].text, type: 'message' } satisfies ResponseMessage;
      }
      return { role: part.role, content, type: 'message' } satisfies ResponseMessage;
    }),
  );
}

async function multiPartPromptToResponse(part: PromptPart): Promise<ResponseInputContent> {
  if ('text' in part) {
    return { type: 'input_text', text: part.text };
  }

  if ('file' in part) {
    const b64 = await fileToBase64(part.file);
    return { type: 'input_image', image_url: b64, detail: 'auto' };
  }

  throw new Error('Unsupported part type');
}

function mergeMessages(a: ResponseMessage[], b: ResponseMessage[]): ResponseMessage[] {
  return [...a, ...b.filter((m) => m.role !== 'system')];
}
