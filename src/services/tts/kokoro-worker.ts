/* eslint-disable @typescript-eslint/no-require-imports --
   Lazy-load kokoro-js + transformers (and the native onnxruntime binary) inside
   the worker so they're only pulled in when Kokoro TTS is actually used. */
import { parentPort } from "worker_threads";
import * as os from "os";
import * as path from "path";

// Kokoro generation (phonemization, ONNX inference, WAV encoding) is CPU-heavy
// and partly synchronous. Running it in the Electron main process blocked the
// event loop ~190 ms per sentence, janking the overlay/chat IPC. This worker
// runs the whole model off the main thread: the main process only sends text
// and receives finished WAV bytes, so its event loop never stalls.

if (!parentPort) {
  throw new Error("kokoro-worker must be run as a worker thread");
}
const port = parentPort;

/**
 * Cap onnxruntime-node's intra-op thread pool so one generation can't peg every
 * core. ORT defaults to one intra-op thread per logical core; q4 inference is
 * memory-bandwidth bound, so half the cores costs little speed while leaving
 * headroom for the rest of the system. kokoro-js doesn't forward
 * `session_options` through `from_pretrained`, so we inject the cap by wrapping
 * the shared `InferenceSession.create` that transformers.js calls. Idempotent
 * and fail-safe: on any error it no-ops back to the default thread count.
 */
let onnxThreadsLimited = false;
function limitOnnxThreads(): void {
  if (onnxThreadsLimited) return;
  try {
    const ort = require("onnxruntime-node");
    const Session = ort.InferenceSession;
    const orig = Session.create.bind(Session);
    const threads = Math.max(1, Math.floor(os.cpus().length / 2));
    Session.create = (...args: unknown[]) => {
      const last = args[args.length - 1];
      const isOpts =
        !!last &&
        typeof last === "object" &&
        !ArrayBuffer.isView(last) &&
        !(last instanceof ArrayBuffer);
      if (isOpts) {
        const o = last as { intraOpNumThreads?: number };
        if (o.intraOpNumThreads == null) o.intraOpNumThreads = threads;
      } else {
        args.push({ intraOpNumThreads: threads });
      }
      return orig(...args);
    };
    onnxThreadsLimited = true;
  } catch {
    /* module not resolvable yet — leave the flag false so a later load retries */
  }
}

/** A kokoro-js RawAudio result (the subset we use). */
type KokoroAudio = {
  audio: Float32Array;
  sampling_rate: number;
  toWav: () => ArrayBuffer;
};

type KokoroModel = {
  generate: (
    text: string,
    opts: { voice: string; speed: number }
  ) => Promise<KokoroAudio>;
};

// One model instance per dtype, shared across every request (loading is ~90–305
// MB and not free). Keyed by dtype so switching quality loads the other variant
// on demand without discarding the one already in memory.
const modelByDtype = new Map<string, Promise<KokoroModel>>();

function loadModel(modelDir: string, dtype: "q4" | "q8"): Promise<KokoroModel> {
  const cached = modelByDtype.get(dtype);
  if (cached) return cached;

  const promise = (async () => {
    // transformers resolves a model as `${localModelPath}/${model_id}`, so point
    // it at the parent dir and pass the folder name as the id. Fully offline.
    const { env } = require("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = path.dirname(modelDir);

    limitOnnxThreads();
    const { KokoroTTS } = require("kokoro-js");
    return KokoroTTS.from_pretrained(path.basename(modelDir), {
      dtype,
      device: "cpu",
    }) as Promise<KokoroModel>;
  })();

  modelByDtype.set(dtype, promise);
  promise.catch(() => modelByDtype.delete(dtype)); // allow a retry on failure
  return promise;
}

interface LoadMsg {
  type: "load";
  id: number;
  modelDir: string;
  dtype: "q4" | "q8";
}
interface GenerateMsg {
  type: "generate";
  id: number;
  modelDir: string;
  dtype: "q4" | "q8";
  text: string;
  voice: string;
  speed: number;
}
type InMsg = LoadMsg | GenerateMsg;

port.on("message", async (msg: InMsg) => {
  try {
    if (msg.type === "load") {
      await loadModel(msg.modelDir, msg.dtype);
      port.postMessage({ type: "done", id: msg.id });
      return;
    }
    if (msg.type === "generate") {
      const tts = await loadModel(msg.modelDir, msg.dtype);
      const audio = await tts.generate(msg.text, {
        voice: msg.voice,
        speed: msg.speed,
      });
      const wav = audio.toWav();
      const durationSec = audio.audio.length / audio.sampling_rate;
      // Transfer the WAV buffer (zero-copy) back to the main process.
      port.postMessage({ type: "done", id: msg.id, wav, durationSec }, [wav]);
    }
  } catch (err) {
    port.postMessage({
      type: "error",
      id: msg?.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
