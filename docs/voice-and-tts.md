# Voice & Text-to-Speech

Clicky supports voice input (speech-to-text) and spoken responses (text-to-speech). Both are optional — you can use Clicky with just text input and silent responses.

## Voice Input (Transcription)

Voice input lets you ask questions by speaking instead of typing. Hold the push-to-talk hotkey, speak, and release.

### Providers

| Provider | Quality | Latency | Privacy | Key Required |
|----------|---------|---------|---------|-------------|
| **Groq Whisper** (default) | Excellent | Low (batch, very fast) | Cloud — audio sent to Groq | Yes |
| **AssemblyAI** | Excellent | Low (real-time streaming) | Cloud — audio sent to AssemblyAI | Yes |
| **OpenAI Whisper API** | Excellent | Medium (batch) | Cloud — audio sent to OpenAI | Yes |
| **Whisper Local** | Good | Higher (depends on hardware) | Private — nothing leaves your device | No |

### Setting Up Groq Whisper (Default)

Groq runs OpenAI's Whisper models on custom LPU hardware — transcription is
typically faster than OpenAI's own endpoint, and Groq's free tier is generous.

1. Sign up at [console.groq.com](https://console.groq.com/)
2. Open **API Keys** in the sidebar and create a new key
3. In Clicky, open Settings (tray > Settings)
4. Paste the key in the **Groq API Key** field
5. Set **Transcription Provider** to "Groq Whisper (cloud, default)"
6. (Optional) Click **Test API Key** to verify the key and refresh the
   model list — the dropdown is auto-populated from Groq's `/models`
   endpoint and re-checks every 5 days
7. (Optional) Override the **Groq Base URL** if you're routing through a
   gateway or proxy — defaults to `https://api.groq.com/openai/v1`
8. Save

The current model is `whisper-large-v3-turbo` (Whisper Large V3 Turbo,
multilingual). Newer STT models Groq adds to the catalog will appear in
the dropdown automatically after a Test.

### Setting Up AssemblyAI

1. Sign up at [assemblyai.com](https://www.assemblyai.com/)
2. Copy your API key from the dashboard
3. In Clicky, open Settings (tray > Settings)
4. Paste the key in the **AssemblyAI API Key** field
5. Set **Transcription Provider** to "AssemblyAI"
6. Save

### Using Local Whisper (No Cloud)

Local Whisper runs transcription entirely on your machine via [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No API key needed, no audio leaves your device.

**1. Download the whisper.cpp Windows binaries**

Grab a prebuilt release from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) (look for a `whisper-bin-x64.zip` or similar) and place the following files in `bin/Release/` at the repo root:

```
bin/Release/
├── whisper-cli.exe
├── whisper.dll
├── ggml.dll
├── ggml-base.dll
└── ggml-cpu.dll
```

**2. Download a Whisper model**

Download a GGML model from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main) and place it in `models/`:

```
models/ggml-base.bin
```

`ggml-base.bin` (~142 MB, multilingual) is a good quality/speed trade-off. Smaller options: `ggml-tiny.bin` (fast, lower quality). Larger: `ggml-small.bin` / `ggml-medium.bin` (slower, better quality).

> Clicky currently hard-codes `ggml-base.bin` as the model filename — if you want to use a different model, either rename your file or update the path in `src/services/transcription/whisper-local.ts`.

**3. Enable in settings**

1. Open Settings from the tray icon
2. Set **Transcription Provider** to "Whisper Local"
3. Save

Performance depends on your CPU. On a modern laptop, `base` transcribes a ~5 second clip in ~1 second.

### Push-to-Talk

The default hotkey is `Ctrl+Alt+Space`. You can change this in Settings under the hotkey configuration.

1. Press and hold the hotkey
2. Speak your question
3. Release — Clicky transcribes and sends your question with a screenshot

## Text-to-Speech (TTS)

TTS makes Clicky speak its responses aloud.

### Providers

| Provider | Voice Quality | Latency | Privacy | Key Required |
|----------|-------------|---------|---------|-------------|
| **ElevenLabs** | Very natural | Low | Cloud — response text sent to ElevenLabs | Yes |
| **OpenAI TTS** | Natural | Low | Cloud — response text sent to OpenAI | Yes |
| **Kokoro** | Very natural | Medium (first reply slower) | Private — nothing leaves your device | No |
| **Windows SAPI** | Robotic but clear | Very low | Private — nothing leaves your device | No |

### Using Kokoro (No Cloud)

Kokoro is an 82M-parameter open-weight neural TTS model (Apache-2.0). It sounds
far more natural than Windows SAPI yet runs **entirely on your machine** via
[kokoro-js](https://www.npmjs.com/package/kokoro-js) — no API key, no server,
nothing leaves the device. It uses the `onnx-community/Kokoro-82M-v1.0-ONNX`
weights through `onnxruntime-node` in the main process.

Clicky ships **two model variants** and lets you pick between them in Settings:

| Quality | dtype | First word (CPU) | Notes |
|---------|-------|------------------|-------|
| **Fast** (default) | q4 | <1s | ~4× faster on CPU; small quality drop |
| **Best** | q8 | ~3s | Slightly cleaner; slower to start on CPU |

(Benchmarked on a Ryzen 5 3600: q4 generates faster than real-time, q8 a bit
slower.) Each variant loads once per session and is cached; generation of each
sentence overlaps playback of the previous one, so replies play back-to-back
with no gaps.

**1. Download the model files**

Clicky loads the model from `resources/kokoro/` at the repo root (gitignored, so
download it separately — packaged builds bundle this folder automatically via
`extraResource` in `forge.config.ts`). From
[onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
place the config/tokenizer files and both ONNX weights so the layout is:

```
resources/kokoro/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    ├── model_q4.onnx          (~305 MB — the q4 "Fast" variant)
    └── model_quantized.onnx   (~92 MB — the q8 "Best" variant)
```

> If you only ever use one quality, you can keep just that variant
> (`model_q4.onnx` for Fast, `model_quantized.onnx` for Best) — the other is
> only loaded when its quality is selected. The **voices** ship inside the
> `kokoro-js` npm package itself, so they need no separate download.

**2. Enable in settings**

1. Open Settings from the tray icon
2. Set **Default Voice** to "Kokoro (offline, natural)"
3. Pick a voice (28 American/British voices), adjust **Speed**, and choose a
   **Quality** (Fast / Best)
4. Save

### Setting Up ElevenLabs

1. Sign up at [elevenlabs.io](https://elevenlabs.io/)
2. Go to your profile > API Keys
3. Copy your API key
4. In Clicky Settings, paste it in the **ElevenLabs API Key** field
5. Set **TTS Provider** to "ElevenLabs"
6. Save

The default voice is `kPzsL2i3teMYv0FxEYQ6`. You can change it in the full Settings panel by entering a different ElevenLabs voice ID.

### Using Windows SAPI (No Cloud)

Windows has built-in speech synthesis. It sounds robotic but works instantly with no setup.

1. Open Settings
2. Set **TTS Provider** to "Windows SAPI"
3. Save

### Disabling TTS

Toggle **Spoken responses** off in Settings if you prefer text-only responses.
