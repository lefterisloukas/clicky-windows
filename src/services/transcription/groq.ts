import { TranscriptionProvider } from "./interface";
import { pcmToWav } from "./wav";

/**
 * Groq Whisper STT provider.
 *
 * Uses Groq's OpenAI-compatible /audio/transcriptions endpoint to batch-
 * transcribe raw 16-bit signed PCM mono 16 kHz audio (the format produced
 * by the renderer's AudioContext.decodeAudioData path). Groq's API is
 * OpenAI-shaped, but the base URL and model are configurable so a single
 * provider implementation covers Groq Cloud, self-hosted gateways, and
 * future model additions.
 *
 * Reference: https://console.groq.com/docs/speech-text
 */
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "whisper-large-v3-turbo";

export class GroqTranscriptionProvider implements TranscriptionProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private audioChunks: Buffer[] = [];
  private partialCallback: ((text: string) => void) | null = null;
  private finalCallback: ((text: string) => void) | null = null;

  constructor(apiKey: string, baseUrl?: string, model?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = model || DEFAULT_MODEL;
  }

  async start(): Promise<void> {
    this.audioChunks = [];
  }

  sendAudio(chunk: Buffer): void {
    this.audioChunks.push(chunk);
  }

  async stop(): Promise<string> {
    if (this.audioChunks.length === 0) return "";

    const pcm = Buffer.concat(this.audioChunks);
    this.audioChunks = [];

    const wavBuffer = pcmToWav(pcm);
    const boundary = "----ClickyGroq" + Date.now();

    const parts: Buffer[] = [];
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      )
    );
    parts.push(wavBuffer);
    parts.push(Buffer.from("\r\n"));
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${this.model}\r\n`
      )
    );
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0\r\n`
      )
    );
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`
      )
    );
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetch(
      `${this.baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq Whisper error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as { text: string };
    this.finalCallback?.(data.text);
    return data.text;
  }

  onPartialTranscript(callback: (text: string) => void): void {
    this.partialCallback = callback;
  }

  onFinalTranscript(callback: (text: string) => void): void {
    this.finalCallback = callback;
  }
}
