import { TTSProvider } from "./interface";
import { app } from "electron";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/* eslint-disable @typescript-eslint/no-require-imports --
   Lazy-load kokoro-js + transformers so they (and the native onnxruntime
   binary) are only pulled in when the Kokoro provider is actually used. */

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

/** A kokoro-js RawAudio result (the subset we use). */
type KokoroAudio = {
  audio: Float32Array;
  sampling_rate: number;
  toWav: () => ArrayBuffer;
};

/**
 * Each model variant is ~90–305 MB and takes a moment to initialize, so it is
 * loaded once per dtype and shared across every speak() call (the TTS factory
 * builds a fresh provider per request — the heavy model must not be). Keyed by
 * dtype so switching the quality setting loads the other variant on demand
 * without discarding the one already in memory.
 */
const modelPromises = new Map<string, Promise<unknown>>();

function resolveModelDir(): string {
  // Mirrors whisper-local.ts: packaged → process.resourcesPath, dev → repo root.
  const appRoot = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, "..", "..", "..", "resources");
  return path.join(appRoot, MODEL_DIR_NAME);
}

function loadModel(dtype: "q4" | "q8"): Promise<unknown> {
  const cached = modelPromises.get(dtype);
  if (cached) return cached;

  const promise = (async () => {
    const modelDir = resolveModelDir();
    if (!fs.existsSync(modelDir)) {
      modelPromises.delete(dtype); // allow a retry once the model is installed
      throw new Error(
        `Kokoro model not found at ${modelDir}. See docs/voice-and-tts.md for installation.`
      );
    }

    // Force fully-offline, local-only loading. transformers resolves the model
    // as `${localModelPath}/${model_id}`, so point it at the parent dir and pass
    // the folder name as the id. Voices are loaded by kokoro-js from its own
    // bundled package dir, so nothing here ever touches the network.
    const { env } = require("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = path.dirname(modelDir);

    const { KokoroTTS } = require("kokoro-js");
    return KokoroTTS.from_pretrained(MODEL_DIR_NAME, { dtype, device: "cpu" });
  })();

  modelPromises.set(dtype, promise);
  // If the load fails, drop it so a later call can retry.
  promise.catch(() => modelPromises.delete(dtype));
  return promise;
}

/**
 * Kokoro TTS — fully local, offline neural text-to-speech via kokoro-js
 * (runs the onnx-community/Kokoro-82M-v1.0-ONNX weights through onnxruntime-node
 * in the main process). No API key, no network, nothing leaves the machine.
 */
export class KokoroTTS implements TTSProvider {
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

  async speak(text: string): Promise<void> {
    this.stop();
    this.stopped = false;

    const tts = (await loadModel(this.dtype)) as {
      generate: (
        text: string,
        opts: { voice: string; speed: number }
      ) => Promise<KokoroAudio>;
    };

    const chunks = this.splitText(text);
    if (chunks.length === 0) return;

    const opts = { voice: this.voice, speed: this.speed };

    // Pipeline generation with playback: kick off generation of the *next*
    // chunk before playing the current one, so CPU inference overlaps with
    // audio playback instead of stacking after it. Only the first chunk's
    // generation is unavoidable "dead" latency; the rest is hidden behind
    // playback, removing the gaps between sentences.
    let pending: Promise<KokoroAudio> = tts.generate(chunks[0], opts);

    for (let i = 0; i < chunks.length; i++) {
      const audio = await pending;
      if (this.stopped) break;
      if (i + 1 < chunks.length) {
        pending = tts.generate(chunks[i + 1], opts);
      }
      await this.playWav(audio);
    }
  }

  private async playWav(audio: KokoroAudio): Promise<void> {
    const wavBuffer = Buffer.from(audio.toWav());
    const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const tmpFile = path.join(os.tmpdir(), `clicky-tts-${stamp}.wav`);
    fs.writeFileSync(tmpFile, wavBuffer);

    // Exact duration from the raw samples (Kokoro outputs 24 kHz mono).
    const durationSeconds = audio.audio.length / audio.sampling_rate;
    const playSeconds = Math.ceil(durationSeconds) + 1;

    return new Promise((resolve, reject) => {
      const psCmd = [
        "Add-Type -AssemblyName presentationCore",
        "$p = New-Object System.Windows.Media.MediaPlayer",
        `$p.Open([Uri]'${tmpFile}')`,
        "$p.Play()",
        `Start-Sleep -Seconds ${playSeconds}`,
        "$p.Close()",
      ].join("; ");

      this.currentProcess = exec(
        `powershell -Command "${psCmd}"`,
        { timeout: playSeconds * 1000 + 5000 },
        (error) => {
          this.currentProcess = null;
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
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
    if (text.length <= MAX_CHARS) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_CHARS) {
        chunks.push(remaining);
        break;
      }

      let breakAt = -1;
      const searchRange = remaining.substring(0, MAX_CHARS);

      for (const sep of [". ", "! ", "? ", ".\n", "!\n", "?\n"]) {
        const idx = searchRange.lastIndexOf(sep);
        if (idx > breakAt) breakAt = idx + sep.length;
      }
      if (breakAt <= 0) {
        const commaIdx = searchRange.lastIndexOf(", ");
        if (commaIdx > 0) breakAt = commaIdx + 2;
      }
      if (breakAt <= 0) {
        const spaceIdx = searchRange.lastIndexOf(" ");
        if (spaceIdx > 0) breakAt = spaceIdx + 1;
      }
      if (breakAt <= 0) breakAt = MAX_CHARS;

      chunks.push(remaining.substring(0, breakAt).trim());
      remaining = remaining.substring(breakAt).trim();
    }

    return chunks;
  }

  stop(): void {
    this.stopped = true;
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }
}
