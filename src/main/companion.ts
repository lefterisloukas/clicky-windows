import { BrowserWindow } from "electron";
import { ScreenCapture, ScreenshotResult, cropScreenshotRegion } from "./screenshot";
import { SettingsStore } from "./settings";
import { ClaudeService } from "../services/claude";
import { OpenAIChatService } from "../services/openai-chat";
import { OpenRouterChatService } from "../services/openrouter-chat";
import { GeminiChatService } from "../services/gemini-chat";
import { OpenCodeGoChatService } from "../services/opencode-go-chat";
import {
  TranscriptionProvider,
  createTranscriptionProvider,
} from "../services/transcription/interface";
import {
  IncrementalPointExtractor,
  IncrementalSentenceExtractor,
  RawPointTag,
} from "../services/incremental";
import { TTSQueue } from "../services/tts/queue";

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

interface AIProvider {
  query(params: {
    transcript: string;
    screenshots: ScreenshotResult[];
    cursorPosition: { x: number; y: number };
    conversationHistory: ConversationEntry[];
    onDelta?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}

/** Captured screen state — may be pre-fetched in parallel with transcription. */
export interface CapturedScreens {
  screenshots: ScreenshotResult[];
  cursorPosition: { x: number; y: number };
}

const MAX_CONVERSATION_HISTORY = 10;

/**
 * A single point pushed to the overlay. `kind:"raw"` is the model's first
 * estimate, shown immediately; `kind:"refine"` carries refined coordinates for
 * the same `id` and updates the already-shown point in place; `kind:"reset"`
 * clears the overlay at the start of a new query.
 *
 * `index` is the 1-based step number across the whole reply, used for the
 * overlay's numbered badges. It rides along on `raw` and is carried on `refine`
 * so a re-render keeps its number.
 */
interface OverlayPoint {
  id?: string;
  index?: number;
  x?: number;
  y?: number;
  label?: string;
  kind: "raw" | "refine" | "reset";
}

/**
 * One in-flight query. Holds the abort controller (cancels the provider's
 * fetch), the TTS queue, and a `cancelled` flag the async refinement calls and
 * streaming callbacks check before touching the UI.
 */
class QuerySession {
  readonly controller = new AbortController();
  cancelled = false;
  tts: TTSQueue | null = null;

  cancel(): void {
    this.cancelled = true;
    this.controller.abort();
    this.tts?.cancel();
  }
}

/** Human-readable name for an AI provider id, for logs. */
function providerLabel(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "Claude";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "gemini":
      return "Gemini";
    case "opencode-go":
      return "OpenCode Go";
    default:
      return provider || "AI";
  }
}

/**
 * Central orchestrator — mirrors CompanionManager.swift from macOS version.
 *
 * Flow: voice → screenshot → ai (streaming) → tts + overlay pointing, all
 * incremental: text streams to chat, each completed POINT tag moves the cursor
 * immediately (Claude refines it concurrently), and each completed sentence is
 * spoken while the rest of the reply is still generating.
 */
export class CompanionManager {
  private settings: SettingsStore;
  private screenCapture: ScreenCapture;
  private transcription: TranscriptionProvider;
  private conversationHistory: ConversationEntry[] = [];
  private overlayWindows: BrowserWindow[] = [];
  private activeSession: QuerySession | null = null;
  private pointSeq = 0;

  // Reuse provider instances across queries so TCP/TLS/HTTP2 connections stay
  // warm. Each service reads settings fresh on every request, so model/key
  // changes are picked up without needing to recreate the instance.
  private claudeProvider: ClaudeService | null = null;
  private openaiProvider: OpenAIChatService | null = null;
  private openrouterProvider: OpenRouterChatService | null = null;
  private geminiProvider: GeminiChatService | null = null;
  private opencodeGoProvider: OpenCodeGoChatService | null = null;

  constructor(settings: SettingsStore, overlayWindows: BrowserWindow[]) {
    this.settings = settings;
    this.screenCapture = new ScreenCapture();
    this.transcription = createTranscriptionProvider(settings);
    this.overlayWindows = overlayWindows;
  }

  private getAIProvider(): AIProvider {
    const provider = this.settings.get("aiProvider");
    if (provider === "openai") {
      return (this.openaiProvider ??= new OpenAIChatService(this.settings));
    }
    if (provider === "openrouter") {
      return (this.openrouterProvider ??= new OpenRouterChatService(this.settings));
    }
    if (provider === "gemini") {
      return (this.geminiProvider ??= new GeminiChatService(this.settings));
    }
    if (provider === "opencode-go") {
      return (this.opencodeGoProvider ??= new OpenCodeGoChatService(this.settings));
    }
    return this.getClaudeService();
  }

  private getClaudeService(): ClaudeService {
    return (this.claudeProvider ??= new ClaudeService(this.settings));
  }

  private broadcastStage(stage: string, label: string): void {
    this.notifyAll("companion:stage", { stage, label });
  }

  /** Send an event to every renderer window (chat status, streaming text). */
  private notifyAll(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    }
  }

  /**
   * Capture all screens + cursor position. Public so callers (e.g. the audio
   * pipeline) can start this in parallel with transcription and pass the result
   * into processQuery, keeping it off the serial path.
   */
  async captureScreens(): Promise<CapturedScreens> {
    const screenshots = await this.screenCapture.captureAllScreens();
    const cursorPosition = this.screenCapture.getCursorPosition();
    return { screenshots, cursorPosition };
  }

  /**
   * Process a user query: capture screen, stream the AI response, and as it
   * arrives push live text to chat, move the overlay cursor per POINT tag, and
   * speak each completed sentence. Returns the full final text.
   *
   * @param prefetched optional screen capture already taken in parallel with
   *                   transcription; if omitted, captured inline here.
   */
  async processQuery(
    transcript: string,
    prefetched?: CapturedScreens
  ): Promise<string> {
    // A newer query supersedes any in-flight one: abort its fetch, stop its TTS.
    this.activeSession?.cancel();
    const session = new QuerySession();
    this.activeSession = session;

    const aiProviderName = this.settings.get("aiProvider");

    try {
      // 1. Capture (reuse the parallel pre-fetch if the caller provided one).
      this.broadcastStage("capturing", "Reading screen...");
      const { screenshots, cursorPosition } =
        prefetched ?? (await this.captureScreens());
      if (session.cancelled) return "";

      // 2. Build the request history WITHOUT mutating the shared history yet —
      //    we only commit the turn pair on success, so a cancelled/failed query
      //    never leaves a dangling user turn behind.
      const pendingHistory: ConversationEntry[] = [
        ...this.conversationHistory,
        { role: "user", content: transcript },
      ];

      this.broadcastStage("querying", "Analyzing...");
      const ai = this.getAIProvider();

      // 3. Streaming consumers.
      const pointEx = new IncrementalPointExtractor();
      const sentenceEx = new IncrementalSentenceExtractor();
      // 1-based step number across this reply, for the overlay's numbered map.
      // Query-local (resets per query), unlike the lifetime `pointSeq` id source.
      let stepIndex = 0;
      if (this.settings.get("ttsEnabled")) {
        // Tell the overlay the moment the voice actually starts, so the numbered
        // map can reveal its first step in sync with speech rather than racing
        // ahead on a timer while TTS is still spinning up.
        session.tts = new TTSQueue(this.settings, () => {
          if (!session.cancelled) this.notifyAll("companion:speaking-started", {});
        });
      }

      // Clear any stale points from a previous query, then open the chat bubble.
      this.resetOverlays();
      this.notifyAll("chat:stream-start", {});

      const onDelta = (chunk: string) => {
        if (session.cancelled) return;

        // 3a. Live text to the chat window (POINT tags stripped renderer-side).
        this.notifyAll("chat:stream-delta", { text: chunk });

        // 3b. Points: show the raw estimate immediately; for Claude, refine
        //     concurrently and nudge the same point into place when it returns.
        for (const tag of pointEx.push(chunk)) {
          const id = `p${this.pointSeq++}`;
          const prepared = this.prepareTag(tag, screenshots);
          if (!prepared) continue;
          // Number only points we actually render, so the badges read 1,2,3…
          const index = ++stepIndex;
          this.sendPoint(prepared.overlayIdx, {
            id,
            index,
            x: prepared.x,
            y: prepared.y,
            label: tag.label,
            kind: "raw",
          });
          // Broadcast the running total to EVERY overlay window (not just this
          // point's display) so each can decide plain-dot vs numbered: a window
          // only sees its own display's points and can't know the global total.
          this.notifyAll("overlay:point-count", { count: stepIndex });
          if (aiProviderName === "anthropic") {
            void this.refineTagAsync(tag, id, index, screenshots, session);
          }
        }

        // 3c. Sentences → TTS, spoken while the rest still streams.
        if (session.tts) {
          for (const sentence of sentenceEx.push(chunk)) {
            session.tts.enqueue(sentence);
          }
        }
      };

      const { text } = await ai.query({
        transcript,
        screenshots,
        cursorPosition,
        conversationHistory: pendingHistory,
        onDelta,
        signal: session.controller.signal,
      });

      // A supersede may have landed while awaiting (notably Gemini, whose abort
      // is cooperative and resolves normally) — bail before touching UI/history.
      if (session.cancelled) return "";

      // Speak any trailing fragment that never hit a sentence boundary.
      if (session.tts) session.tts.enqueue(sentenceEx.flush());

      // Every sentence is now queued. Wait (off the critical path) for playback
      // to fully drain, then tell the overlay the voice has stopped so its
      // response caption can linger exactly as long as the speech, not the
      // text reveal. Gated on !cancelled so a superseded query stays silent.
      if (session.tts) {
        const tts = session.tts;
        void tts.whenIdle().then(() => {
          if (!session.cancelled) this.notifyAll("companion:speaking-ended", {});
        });
      }

      console.log(`[Clicky] ${providerLabel(aiProviderName)} response:`, text);

      // 4. Commit the turn to shared history. Always keep the user turn so a
      //    cancelled/failed/empty reply doesn't silently erase the question from
      //    later context; only skip an empty assistant turn.
      this.conversationHistory.push({ role: "user", content: transcript });
      if (text.trim()) {
        this.conversationHistory.push({ role: "assistant", content: text });
      }
      if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY * 2) {
        this.conversationHistory = this.conversationHistory.slice(
          -MAX_CONVERSATION_HISTORY * 2
        );
      }

      this.notifyAll("chat:stream-end", { text });
      return text;
    } catch (err: unknown) {
      // Superseded query — the newer one owns the UI now; stay silent.
      if (session.cancelled) return "";
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Clicky] processQuery error:", msg);
      // Close the chat bubble so it doesn't hang in a streaming state.
      this.notifyAll("chat:stream-end", { text: "", error: msg });
      throw err;
    } finally {
      // Only the still-active session clears state / hides status — a superseded
      // session must not stomp the newer query's stage updates.
      if (this.activeSession === session) {
        this.activeSession = null;
        this.broadcastStage("done", "");
      }
    }
  }

  /**
   * Map a POINT tag (image-pixel space) to overlay display-pixel space.
   * Returns the target overlay index plus clamped+scaled coordinates, or null
   * if the referenced screenshot is missing.
   *
   * `overlayIdx` comes from the screenshot's true `displayIndex`, never the raw
   * `screen` field — a display skipped during capture shifts array positions,
   * and routing by displayIndex is what keeps points on the correct monitor.
   */
  private prepareTag(
    tag: RawPointTag,
    screenshots: ScreenshotResult[]
  ): { overlayIdx: number; x: number; y: number } | null {
    const shot = screenshots[tag.screen] || screenshots[0];
    if (!shot) return null;

    // Models routinely overshoot the image bounds by a few px; clamp so an
    // overshoot snaps to the visible edge instead of flying off-screen.
    const clampedImgX = Math.max(
      0,
      Math.min(shot.imageDimensions.width - 1, tag.x)
    );
    const clampedImgY = Math.max(
      0,
      Math.min(shot.imageDimensions.height - 1, tag.y)
    );
    const scaleX = shot.bounds.width / shot.imageDimensions.width;
    const scaleY = shot.bounds.height / shot.imageDimensions.height;
    return {
      overlayIdx: shot.displayIndex,
      x: Math.round(clampedImgX * scaleX),
      y: Math.round(clampedImgY * scaleY),
    };
  }

  /** Route a single overlay point to the window for its display. */
  private sendPoint(overlayIdx: number, point: OverlayPoint): void {
    const idx =
      overlayIdx >= 0 && overlayIdx < this.overlayWindows.length
        ? overlayIdx
        : 0;
    const win = this.overlayWindows[idx];
    if (win && !win.isDestroyed()) {
      win.webContents.send("overlay:point", point);
    }
  }

  /** Clear every overlay's point queue (start of a new query). */
  private resetOverlays(): void {
    for (const win of this.overlayWindows) {
      if (win && !win.isDestroyed()) {
        win.webContents.send("overlay:point", { kind: "reset" });
      }
    }
  }

  /**
   * Claude-only second-pass refinement for one POINT tag, run concurrently with
   * the still-streaming response. Crops ~300 imageDim px around the estimate at
   * native DPI, asks Claude for the precise center, then nudges the already-
   * shown overlay point (same `id`) into place. Best-effort: any failure leaves
   * the raw point as-is.
   */
  private async refineTagAsync(
    tag: RawPointTag,
    id: string,
    index: number,
    screenshots: ScreenshotResult[],
    session: QuerySession
  ): Promise<void> {
    const shot = screenshots[tag.screen] || screenshots[0];
    if (!shot) return;
    try {
      const crop = cropScreenshotRegion(shot, tag.x, tag.y, 300);
      const refined = await this.getClaudeService().refinePoint(
        crop.data,
        crop.claudeSize.w,
        crop.claudeSize.h,
        tag.label
      );
      if (session.cancelled || !refined) return;

      // Refined coords are native crop-pixel space → map back to imageDims,
      // then through prepareTag for identical clamp/scale/routing as the raw.
      const imgX = crop.origin.x + refined.x / crop.pxPerImageDim;
      const imgY = crop.origin.y + refined.y / crop.pxPerImageDim;
      const prepared = this.prepareTag(
        { x: Math.round(imgX), y: Math.round(imgY), label: tag.label, screen: tag.screen },
        screenshots
      );
      if (!prepared) return;

      console.log(
        `[Clicky] Refined "${tag.label}": (${tag.x},${tag.y}) -> (${Math.round(imgX)},${Math.round(imgY)})`
      );
      this.sendPoint(prepared.overlayIdx, {
        id,
        index,
        x: prepared.x,
        y: prepared.y,
        label: tag.label,
        kind: "refine",
      });
    } catch (err) {
      console.warn(
        `[Clicky] Refinement failed for "${tag.label}":`,
        err instanceof Error ? err.message : err
      );
    }
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }
}
