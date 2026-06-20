import { PipelinedTTSProvider, Synthesized } from "./interface";
import { splitText } from "../incremental";
import { app } from "electron";
import { Worker } from "worker_threads";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Kokoro's phoneme context is ~510 tokens; keep chunks well under that so the
// model never silently truncates. Smaller chunks also cut time-to-first-audio
// (the first sentence generates and starts playing sooner) — splitting on
// sentence boundaries keeps the prosody natural.
const MAX_CHARS = 180;

// Quality → ONNX dtype. On CPU, q4 (4-bit) is dramatically faster than q8 here
// (~4× on a Ryzen 5 3600: <1s vs ~3.5s to first word) with only a small quality
// drop, so "fast" is the default. Both variants are bundled — see
// docs/voice-and-tts.md.
export type KokoroQuality = "fast" | "best";
const DTYPE_FOR_QUALITY: Record<KokoroQuality, "q4" | "q8"> = {
  fast: "q4",
  best: "q8",
};

// Model name == the folder we bundle under resources/. The full repo lives at
// onnx-community/Kokoro-82M-v1.0-ONNX; we ship config + onnx/model_q4.onnx +
// onnx/model_quantized.onnx.
const MODEL_DIR_NAME = "kokoro";

function resolveModelDir(): string {
  // Mirrors whisper-local.ts: packaged → process.resourcesPath, dev → repo root.
  const appRoot = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, "..", "..", "..", "resources");
  return path.join(appRoot, MODEL_DIR_NAME);
}

/** Resolve the model dir, throwing a clear error if it isn't installed. */
function modelDirOrThrow(): string {
  const modelDir = resolveModelDir();
  if (!fs.existsSync(modelDir)) {
    throw new Error(
      `Kokoro model not found at ${modelDir}. See docs/voice-and-tts.md for installation.`
    );
  }
  return modelDir;
}

/* --- Worker bridge --------------------------------------------------------
 * The model (phonemization, ONNX inference, WAV encoding) runs in a single
 * shared worker thread, NOT the Electron main process — that synchronous work
 * was blocking the main event loop ~190 ms per sentence and janking the overlay
 * and chat IPC. Here we only post text and await finished WAV bytes, so the
 * main thread never stalls. The worker is created lazily and kept warm across
 * queries; if it dies it's recreated on the next request.
 */

interface GenResult {
  wav: ArrayBuffer;
  durationSec: number;
}
type WorkerReply =
  | { type: "done"; id: number; wav?: ArrayBuffer; durationSec?: number }
  | { type: "error"; id: number; message: string };

let worker: Worker | null = null;
let reqSeq = 0;
const pending = new Map<
  number,
  { resolve: (v: GenResult | undefined) => void; reject: (e: Error) => void }
>();

function failAllPending(err: Error): void {
  for (const { reject } of pending.values()) reject(err);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;

  // __dirname is dist/services/tts at runtime; the worker is compiled beside it.
  const w = new Worker(path.join(__dirname, "kokoro-worker.js"));

  w.on("message", (msg: WorkerReply) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "error") {
      p.reject(new Error(msg.message));
    } else if (msg.wav) {
      p.resolve({ wav: msg.wav, durationSec: msg.durationSec ?? 0 });
    } else {
      p.resolve(undefined); // load ack
    }
  });
  // A worker crash/exit must reject in-flight work and clear the singleton so
  // the next request spins up a fresh one rather than hanging forever.
  w.on("error", (err) => {
    failAllPending(err instanceof Error ? err : new Error(String(err)));
    if (worker === w) worker = null;
  });
  w.on("exit", () => {
    failAllPending(new Error("Kokoro worker exited"));
    if (worker === w) worker = null;
  });

  worker = w;
  return w;
}

function request(
  msg: Record<string, unknown>
): Promise<GenResult | undefined> {
  const w = getWorker();
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id });
  });
}

/**
 * Warm the Kokoro model in the worker ahead of the first `speak()` call, so the
 * first reply doesn't pay the ~1s cold-load cost. Best-effort — if the model
 * isn't installed it rejects, which the caller should swallow (the real error
 * surfaces at speak time, exactly as before).
 */
export function prewarmKokoro(
  quality: KokoroQuality = "fast"
): Promise<unknown> {
  const dtype = DTYPE_FOR_QUALITY[quality] ?? DTYPE_FOR_QUALITY.fast;
  return request({ type: "load", modelDir: modelDirOrThrow(), dtype });
}

/**
 * Kokoro TTS — fully local, offline neural text-to-speech via kokoro-js
 * (runs the onnx-community/Kokoro-82M-v1.0-ONNX weights through onnxruntime-node
 * in a worker thread). No API key, no network, nothing leaves the machine.
 */
export class KokoroTTS implements PipelinedTTSProvider {
  private voice: string;
  private speed: number;
  private dtype: "q4" | "q8";
  private currentProcess: ReturnType<typeof exec> | null = null;
  private stopped = false;

  constructor(
    voice: string = "af_heart",
    speed: number = 1.0,
    quality: KokoroQuality = "fast"
  ) {
    this.voice = voice || "af_heart";
    this.speed = speed > 0 ? speed : 1.0;
    this.dtype = DTYPE_FOR_QUALITY[quality] ?? DTYPE_FOR_QUALITY.fast;
  }

  /** Generate one chunk's audio in the worker. */
  private generate(modelDir: string, chunk: string): Promise<GenResult> {
    return request({
      type: "generate",
      modelDir,
      dtype: this.dtype,
      text: chunk,
      voice: this.voice,
      speed: this.speed,
    }) as Promise<GenResult>;
  }

  async speak(text: string): Promise<void> {
    this.stop();
    this.stopped = false;

    const modelDir = modelDirOrThrow();
    const chunks = this.splitText(text);
    if (chunks.length === 0) return;

    // Pipeline generation with playback: kick off generation of the *next* chunk
    // (in the worker) before playing the current one, so inference overlaps with
    // audio playback instead of stacking after it. Only the first chunk's
    // generation is unavoidable "dead" latency; the rest is hidden behind
    // playback, removing the gaps between sentences.
    let next: Promise<GenResult> = this.generate(modelDir, chunks[0]);

    for (let i = 0; i < chunks.length; i++) {
      const result = await next;
      if (this.stopped) break;
      if (i + 1 < chunks.length) {
        next = this.generate(modelDir, chunks[i + 1]);
      }
      await this.playWav(result);
    }
  }

  /**
   * Synthesize (but don't play) one utterance. TTSQueue calls this to generate
   * the next sentence's audio in the worker *while the current one is playing*,
   * which is what removes the inter-sentence gap. Generation happens now; the
   * returned `play()` only does playback (and is awaited sequentially by the
   * queue, so `stop()` only ever fires against a single in-flight playback).
   */
  async synthesize(text: string): Promise<Synthesized> {
    this.stopped = false;
    const modelDir = modelDirOrThrow();
    const chunks = this.splitText(text);
    const results = await Promise.all(
      chunks.map((c) => this.generate(modelDir, c))
    );
    return {
      play: async () => {
        for (const result of results) {
          if (this.stopped) break;
          await this.playWav(result);
        }
      },
    };
  }

  private async playWav({ wav, durationSec }: GenResult): Promise<void> {
    const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const tmpFile = path.join(os.tmpdir(), `clicky-tts-${stamp}.wav`);
    // Async write so the main thread isn't blocked on disk I/O per sentence.
    await fs.promises.writeFile(tmpFile, Buffer.from(wav));

    return new Promise((resolve, reject) => {
      // SoundPlayer.PlaySync() plays the WAV and blocks for exactly its length,
      // so there is no inter-sentence gap from a guessed Start-Sleep, and it
      // avoids cold-loading the heavyweight WPF PresentationCore assembly that
      // MediaPlayer requires. durationSec only bounds the process timeout.
      const psCmd = [
        `$p = New-Object System.Media.SoundPlayer '${tmpFile}'`,
        "$p.PlaySync()",
      ].join("; ");

      this.currentProcess = exec(
        `powershell -Command "${psCmd}"`,
        { timeout: Math.ceil(durationSec) * 1000 + 5000 },
        (error) => {
          this.currentProcess = null;
          fs.promises.unlink(tmpFile).catch(() => {
            /* ignore */
          });
          if (error && !error.killed) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  }

  private splitText(text: string): string[] {
    return splitText(text, MAX_CHARS);
  }

  stop(): void {
    this.stopped = true;
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }
}
