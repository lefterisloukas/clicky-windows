import { SettingsStore } from "../../main/settings";
import { TTSProvider, createTTSProvider } from "./interface";

/**
 * Per-query TTS coordinator for the streaming pipeline.
 *
 * The streaming orchestrator extracts completed sentences as the model
 * generates and feeds them here one at a time via `enqueue`, so the first
 * sentence can start speaking while the rest is still being generated.
 *
 * Why a queue rather than calling `provider.speak()` directly per sentence:
 * every provider's `speak()` calls `stop()` at the top (to interrupt a previous
 * utterance), so two overlapping `speak()` calls on the same instance would
 * kill each other's audio. We hold ONE provider instance per query and chain
 * each `speak()` after the previous one resolves, so playback is strictly
 * sequential and the internal `stop()` only ever fires when nothing is playing.
 *
 * `cancel()` is the single place we stop mid-playback — used when a newer query
 * supersedes this one.
 */
export class TTSQueue {
  private provider: TTSProvider | null = null;
  private chain: Promise<void> = Promise.resolve();
  private cancelled = false;

  constructor(private readonly settings: SettingsStore) {}

  /** Queue a sentence for sequential playback. No-op once cancelled. */
  enqueue(sentence: string | null | undefined): void {
    if (this.cancelled || !sentence || !sentence.trim()) return;

    if (!this.provider) {
      try {
        this.provider = createTTSProvider(this.settings);
      } catch (err: unknown) {
        // Provider misconfigured (e.g. missing key) — disable for this query.
        console.warn(
          "TTS provider creation failed:",
          err instanceof Error ? err.message : err
        );
        this.cancelled = true;
        return;
      }
    }

    const text = sentence.trim();
    this.chain = this.chain.then(() => {
      if (this.cancelled || !this.provider) return;
      return this.provider.speak(text).catch((err) => {
        // One failed sentence must not break the rest of the chain.
        console.warn(
          "TTS sentence failed (non-fatal):",
          err instanceof Error ? err.message : err
        );
      });
    });
  }

  /** Stop any in-flight audio and drop the queue. Safe to call repeatedly. */
  cancel(): void {
    this.cancelled = true;
    this.provider?.stop();
    this.chain = Promise.resolve();
  }
}
