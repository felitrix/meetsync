import { ollama } from './ollama-client';
import { nvidiaRelay, type NvidiaOperation, type NvidiaUsage } from './nvidia-relay-client';

export type AiGenerateRequest = {
  model: string;
  prompt: string;
  meetingId: string;
  operation: NvidiaOperation;
  maxOutputTokens?: number;
  onChunk?: (accumulated: string) => void;
  confirmed?: boolean;
  confidential?: boolean;
  anonymized?: boolean;
};

export type AiProviderUsage = NvidiaUsage | { local: true };

export interface AiProvider {
  readonly id: 'ollama' | 'nvidia-relay';
  test(): Promise<boolean>;
  listModels(): Promise<string[]>;
  generate(request: AiGenerateRequest): Promise<string>;
  usage(): Promise<AiProviderUsage>;
}

export function createOllamaProvider(url: string): AiProvider {
  return {
    id: 'ollama',
    test: () => ollama.test(url),
    listModels: () => ollama.listModels(url),
    async generate(request) {
      if (request.onChunk) return ollama.generateStream(url, request.model, request.prompt, request.onChunk);
      return ollama.generate(url, request.model, request.prompt);
    },
    usage: async () => ({ local: true }),
  };
}

export function createNvidiaRelayProvider(url: string, token: string): AiProvider {
  return {
    id: 'nvidia-relay',
    async test() { return (await nvidiaRelay.test(url, token)).paired; },
    async listModels() { return (await nvidiaRelay.listModels(url, token)).models; },
    async generate(request) {
      if (request.confirmed !== true) throw new Error('Confirmação explícita obrigatória para usar NVIDIA.');
      if (request.confidential === true) throw new Error('Reunião confidencial bloqueada para NVIDIA.');
      const result = await nvidiaRelay.generate({
        url,
        token,
        model: request.model,
        prompt: request.prompt,
        meetingId: request.meetingId,
        operation: request.operation,
        maxTokens: request.maxOutputTokens ?? 1_200,
        confirmed: true,
        confidential: false,
        anonymized: request.anonymized === true,
      });
      if (request.onChunk) request.onChunk(result.text);
      return result.text.trim();
    },
    usage: () => nvidiaRelay.usage(url, token),
  };
}
