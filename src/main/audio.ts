import { ipcMain, BrowserWindow } from "electron";
import { SettingsStore } from "./settings";
import { CompanionManager } from "./companion";
import { WhisperLocalProvider } from "../services/transcription/whisper-local";
import { pcmToWav } from "../services/transcription/wav";

/**
 * Coordinates push-to-talk audio capture between renderer and main.
 *
 * Flow:
 * 1. Hotkey toggle → renderer starts/stops mic via getUserMedia + MediaRecorder
 * 2. On stop, renderer decodes the webm blob to 16-bit signed PCM mono 16 kHz
 *    (via AudioContext.decodeAudioData) and sends the raw PCM buffer to main.
 * 3. Main dispatches the PCM to the configured transcription provider:
 *      - "whisper-local" → spawn whisper.cpp locally (nothing leaves the device)
 *      - "openai" / "assemblyai" → wrap PCM in a WAV header and POST to the
 *        OpenAI Whisper API
 * 4. Transcript → CompanionManager.processQuery() → response back to chat.
 */
export class AudioCapture {
  private settings: SettingsStore;
  private companion: CompanionManager | null = null;

  constructor(settings: SettingsStore) {
    this.settings = settings;
    this.setupIPC();
  }

  setCompanion(companion: CompanionManager): void {
    this.companion = companion;
  }

  private setupIPC(): void {
    // Renderer sends complete PCM recording as ArrayBuffer
    ipcMain.handle(
      "audio:recording-complete",
      async (_event, audioData: ArrayBuffer) => {
        try {
          // Capture the screen NOW (mic just stopped — this is the state the
          // user is asking about) in parallel with transcription, so the
          // ~0.3–1s capture cost overlaps the transcription instead of being
          // tacked on after it. Kicked off before the await; consumed below.
          const capturePromise = this.companion
            ? this.companion.captureScreens().catch((err) => {
                // Don't let a capture failure sink the whole query — fall back
                // to letting processQuery capture inline.
                console.warn(
                  "Parallel screen capture failed; will capture inline:",
                  err instanceof Error ? err.message : err
                );
                return undefined;
              })
            : Promise.resolve(undefined);

          const transcript = await this.transcribe(Buffer.from(audioData));
          if (!transcript || !transcript.trim()) {
            // No query runs, so processQuery's terminal "done" stage never
            // fires — send one so the overlay leaves its thinking state.
            this.signalProcessingDone();
            return { error: "No speech detected" };
          }

          console.log(
            `Transcript received (length ${transcript.length}): ${transcript}`
          );

          // Send transcript to chat UI immediately
          this.notifyChat("voice:transcript", transcript);

          // Process query through companion, reusing the parallel capture.
          if (this.companion) {
            const prefetched = await capturePromise;
            const response = await this.companion.processQuery(
              transcript,
              prefetched
            );
            return { transcript, response };
          }

          this.signalProcessingDone();
          return { transcript, error: "Companion not ready" };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("Voice pipeline error:", msg);
          // Transcription/pipeline failed before (or instead of) processQuery's
          // own "done"; signal idle so the overlay doesn't hang in thinking.
          this.signalProcessingDone();
          return { error: msg };
        }
      }
    );
  }

  private async transcribe(pcmBuffer: Buffer): Promise<string> {
    // 16kHz × 16-bit mono = 32 000 bytes/s. Cap at 60 s to bound memory usage.
    const MAX_PCM_BYTES = 60 * 32_000;
    if (pcmBuffer.length > MAX_PCM_BYTES) {
      pcmBuffer = pcmBuffer.subarray(0, MAX_PCM_BYTES);
    }

    const provider = this.settings.get("transcriptionProvider");

    // Local Whisper via whisper.cpp — no audio leaves the device.
    if (provider === "whisper-local") {
      const local = new WhisperLocalProvider();
      await local.start();
      local.sendAudio(pcmBuffer);
      return local.stop();
    }

    // Groq Whisper — OpenAI-compatible endpoint, configurable base URL/model.
    if (provider === "groq") {
      const groqKey = this.settings.get("groqApiKey");
      if (!groqKey) {
        throw new Error(
          "Groq is selected as the transcription provider but no Groq API key is set. Add one in Settings."
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy-load
      const { GroqTranscriptionProvider } = require("../services/transcription/groq");
      const groq = new GroqTranscriptionProvider(
        groqKey,
        this.settings.get("groqBaseUrl"),
        this.settings.get("groqSttModel")
      );
      await groq.start();
      groq.sendAudio(pcmBuffer);
      return groq.stop();
    }

    // OpenAI / AssemblyAI both fall through to the OpenAI Whisper API.
    if (provider === "openai" || provider === "assemblyai") {
      const openaiKey = this.settings.get("openaiApiKey");
      if (openaiKey) {
        return this.transcribeWhisper(pcmBuffer, openaiKey);
      }
    }

    // Last-resort fallback: if an OpenAI key is present, use it regardless of setting.
    const openaiKey = this.settings.get("openaiApiKey");
    if (openaiKey) {
      return this.transcribeWhisper(pcmBuffer, openaiKey);
    }

    throw new Error(
      "No transcription provider configured. Add an API key for the selected provider in Settings, or switch to 'whisper-local'."
    );
  }

  /**
   * Send raw PCM to the OpenAI Whisper API, wrapped in a WAV container.
   */
  private async transcribeWhisper(
    pcmBuffer: Buffer,
    apiKey: string
  ): Promise<string> {
    const wavBuffer = pcmToWav(pcmBuffer);
    const boundary = "----ClickyAudio" + Date.now();

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
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`
      )
    );
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as { text: string };
    return data.text;
  }

  private notifyChat(channel: string, data: unknown): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }

  /**
   * Broadcast the pipeline's terminal "done" stage. processQuery emits this
   * itself on the normal path; we only need it on the early-exit paths (empty
   * transcript, transcription error) where processQuery never runs, so the
   * overlay's companion can leave its thinking state and return to idle.
   */
  private signalProcessingDone(): void {
    this.notifyChat("companion:stage", { stage: "done", label: "" });
  }
}

