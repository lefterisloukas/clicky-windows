import { SettingsStore } from "../../main/settings";

export interface TranscriptionProvider {
  /** Start a transcription session (e.g., open websocket) */
  start(): Promise<void>;

  /** Send an audio chunk for transcription */
  sendAudio(chunk: Buffer): void;

  /** Stop the session and get final transcript */
  stop(): Promise<string>;

  /** Register callback for partial/streaming transcripts */
  onPartialTranscript(callback: (text: string) => void): void;

  /** Register callback for final transcript */
  onFinalTranscript(callback: (text: string) => void): void;
}

/* eslint-disable @typescript-eslint/no-require-imports --
   Lazy-load each provider so unused ones don't get bundled in. */
export function createTranscriptionProvider(
  settings: SettingsStore
): TranscriptionProvider {
  const provider = settings.get("transcriptionProvider");

  switch (provider) {
    case "assemblyai":
      const { AssemblyAIProvider } = require("./assemblyai");
      return new AssemblyAIProvider(settings.get("assemblyaiApiKey"));

    case "openai":
      const { OpenAITranscriptionProvider } = require("./openai");
      return new OpenAITranscriptionProvider(settings.get("openaiApiKey"));

    case "groq":
      const { GroqTranscriptionProvider } = require("./groq");
      return new GroqTranscriptionProvider(
        settings.get("groqApiKey"),
        settings.get("groqBaseUrl"),
        settings.get("groqSttModel")
      );

    case "whisper-local":
      const { WhisperLocalProvider } = require("./whisper-local");
      return new WhisperLocalProvider();

    default:
      throw new Error(`Unknown transcription provider: ${provider}`);
  }
}
