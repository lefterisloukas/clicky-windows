import { SettingsStore } from "../../main/settings";

export interface TTSProvider {
  speak(text: string): Promise<void>;
  stop(): void;
}

/** A synthesized utterance ready to play. Returned by `synthesize()`. */
export interface Synthesized {
  play(): Promise<void>;
}

/**
 * Optional capability: a provider that can split *synthesis* (produce the audio)
 * from *playback*. When a provider implements this, `TTSQueue` pipelines it —
 * generating the next sentence while the current one is still playing, which
 * removes the ~1s generation gap between sentences. Providers that don't
 * implement it fall back to sequential `speak()` calls (unchanged behaviour).
 */
export interface PipelinedTTSProvider extends TTSProvider {
  synthesize(text: string): Promise<Synthesized>;
}

export function isPipelined(p: TTSProvider): p is PipelinedTTSProvider {
  return typeof (p as PipelinedTTSProvider).synthesize === "function";
}

/* eslint-disable @typescript-eslint/no-require-imports --
   Lazy-load each provider so unused ones don't get bundled in. */
export function createTTSProvider(settings: SettingsStore): TTSProvider {
  const provider = settings.get("ttsProvider");

  switch (provider) {
    case "elevenlabs": {
      const { ElevenLabsTTS } = require("./elevenlabs");
      return new ElevenLabsTTS(
        settings.get("elevenlabsApiKey"),
        settings.get("elevenlabsVoiceId")
      );
    }
    case "openai": {
      const { OpenAITTS } = require("./openai");
      return new OpenAITTS(
        settings.get("openaiApiKey"),
        settings.get("openaiTtsVoice")
      );
    }
    case "local": {
      const { LocalTTS } = require("./local");
      return new LocalTTS();
    }
    case "kokoro": {
      const { KokoroTTS } = require("./kokoro");
      return new KokoroTTS(
        settings.get("kokoroVoice"),
        Number(settings.get("kokoroSpeed")) || 1.0,
        settings.get("kokoroQuality")
      );
    }
    default:
      throw new Error(`Unknown TTS provider: ${provider}`);
  }
}
