import { SettingsStore } from "../../main/settings";
import {
  TTSProvider,
  PipelinedTTSProvider,
  Synthesized,
  createTTSProvider,
  isPipelined,
} from "./interface";

/**
 * Per-query TTS coordinator for the streaming pipeline.
 *
 * The streaming orchestrator extracts completed sentences as the model
 * generates and feeds them here one at a time via `enqueue`, so the first
 * sentence can start speaking while the rest is still being generated.
 *
 * Two playback strategies:
 *
 *  - **Pipelined** (providers implementing `synthesize()`, e.g. Kokoro): the
 *    pump generates the *next* sentence's audio while the current one is still
 *    playing, removing the ~1s generation gap between sentences. Playback stays
 *    strictly sequential; only generation runs ahead (by one).
 *  - **Sequential** (everything else): each `speak()` is chained after the
 *    previous one resolves. Every provider's `speak()` calls `stop()` at the
 *    top, so two overlapping `speak()` calls on the same instance would kill
 *    each other's audio — chaining keeps them apart.
 *
 * `cancel()` is the single place we stop mid-playback — used when a newer query
 * supersedes this one.
 */
export class TTSQueue {
  private provider: TTSProvider | null = null;
  private cancelled = false;

  // Sequential (fallback) path.
  private chain: Promise<void> = Promise.resolve();
  private seqActive = 0;

  // Pipelined path.
  private texts: string[] = [];
  private pumping = false;

  // Resolvers waiting on whenIdle() — drained once all queued audio has played.
  private idleResolvers: Array<() => void> = [];

  // Fired once, the first time any audio actually starts playing. Lets the
  // overlay align its first step reveal with the voice instead of a timer.
  private firstPlayed = false;

  constructor(
    private readonly settings: SettingsStore,
    private readonly onFirstPlay?: () => void
  ) {}

  /** Fire onFirstPlay exactly once, when the first clip begins playing. */
  private notifyFirstPlay(): void {
    if (this.firstPlayed || this.cancelled) return;
    this.firstPlayed = true;
    try {
      this.onFirstPlay?.();
    } catch {
      /* non-fatal: a listener error must not break playback */
    }
  }

  /** Queue a sentence for playback. No-op once cancelled. */
  enqueue(sentence: string | null | undefined): void {
    if (this.cancelled || !sentence || !sentence.trim()) return;
    if (!this.ensureProvider()) return;
    const text = sentence.trim();

    if (isPipelined(this.provider!)) {
      this.texts.push(text);
      void this.pump(this.provider as PipelinedTTSProvider);
    } else {
      this.seqActive++;
      this.chain = this.chain
        .then(() => {
          if (this.cancelled || !this.provider) return;
          this.notifyFirstPlay();  // this sentence is about to play
          return this.provider.speak(text).catch((err) => {
            console.warn(
              "TTS sentence failed (non-fatal):",
              err instanceof Error ? err.message : err
            );
          });
        })
        .finally(() => {
          this.seqActive--;
          this.settleIdle();
        });
    }
  }

  /**
   * Resolve once every queued sentence has finished playing. Only meaningful
   * after the final `enqueue` for a query — call it after the trailing flush,
   * or it may resolve during a gap in streaming. Resolves immediately if the
   * queue is already idle (nothing enqueued, or all done).
   */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private isIdle(): boolean {
    return (
      this.cancelled ||
      (this.texts.length === 0 && !this.pumping && this.seqActive === 0)
    );
  }

  /** Drain idle waiters once nothing is queued or playing. */
  private settleIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of waiters) resolve();
  }

  /** Lazily create the provider; disables the queue if creation fails. */
  private ensureProvider(): boolean {
    if (this.provider) return true;
    try {
      this.provider = createTTSProvider(this.settings);
      return true;
    } catch (err: unknown) {
      // Provider misconfigured (e.g. missing key) — disable for this query.
      console.warn(
        "TTS provider creation failed:",
        err instanceof Error ? err.message : err
      );
      this.cancelled = true;
      return false;
    }
  }

  /**
   * Drain the text queue, generating one sentence ahead of playback. Re-entrant-
   * safe (the `pumping` guard ensures a single active pump); a sentence enqueued
   * after the queue drains restarts it.
   */
  private async pump(provider: PipelinedTTSProvider): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    let pending: Promise<Synthesized> | null = null;
    try {
      while (!this.cancelled) {
        if (!pending) {
          const text = this.texts.shift();
          if (text === undefined) break;
          pending = provider.synthesize(text);
        }

        let synth: Synthesized;
        try {
          synth = await pending;
        } catch (err) {
          console.warn(
            "TTS synthesis failed (non-fatal):",
            err instanceof Error ? err.message : err
          );
          pending = null;
          continue;
        }
        pending = null;
        if (this.cancelled) break;

        // Start generating the next sentence *before* playing this one, so
        // generation overlaps playback instead of stacking after it.
        const nextText = this.texts.shift();
        if (nextText !== undefined) pending = provider.synthesize(nextText);

        try {
          this.notifyFirstPlay();  // first clip is about to play
          await synth.play();
        } catch (err) {
          console.warn(
            "TTS playback failed (non-fatal):",
            err instanceof Error ? err.message : err
          );
        }
      }
    } finally {
      this.pumping = false;
      // Swallow a prefetched-but-unplayed result so it can't surface as an
      // unhandled rejection, then restart if work arrived during the tail.
      if (pending) pending.catch(() => {});
      if (!this.cancelled && this.texts.length > 0) {
        void this.pump(provider);
      } else {
        this.settleIdle();
      }
    }
  }

  /** Stop any in-flight audio and drop the queue. Safe to call repeatedly. */
  cancel(): void {
    this.cancelled = true;
    this.texts = [];
    this.provider?.stop();
    this.chain = Promise.resolve();
    // Release any whenIdle() waiter so a superseded query never hangs. The
    // companion gates on session.cancelled, so this won't emit a stray event.
    this.settleIdle();
  }
}
