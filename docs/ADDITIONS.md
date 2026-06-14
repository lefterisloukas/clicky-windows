# Additions Log

Chronological record of features, fixes, and changes added to the project.
Each entry is dated and time-stamped (local time, `Europe/Istanbul` / UTC+3
unless otherwise noted). Newest entries go at the top.

---

## 2026-06-14

### feat/june14fixes-after-kokoro — logging + TTS-label fixes
**Time:** ~14:30 (local, UTC+3)
**Branch:** `feat/june14fixes-after-kokoro` (cut from `feat/kokorotts`)
**Author:** Claude Code

Small post-Kokoro polish pass. Four independent fixes, all additive:

- **Provider-accurate response log.** `src/main/companion.ts` always logged
  `[Clicky] Claude response:` regardless of the active provider. Added a
  `providerLabel()` helper (anthropic → Claude, openai → OpenAI, openrouter →
  OpenRouter, gemini → Gemini, else the raw id) and the log line now reflects
  the real provider.
- **Console arrow mojibake.** The Unicode arrows (`→` / `←`) in log strings
  rendered as `ΓåÆ` / `ΓåÉ` in the Windows console (code-page mismatch).
  Replaced them with ASCII `->` / `<-` in `src/main/companion.ts` (4 lines)
  and `src/main/screenshot.ts` (1 line).
- **Readable TTS toggle labels.** The chat quick-toggle showed cramped codes
  `KOK` / `WIN` / `AI` (the `KOK` read as Greek "κοκ" to the user). Changed to
  full names `Kokoro` / `Windows` / `OpenAI` in
  `src/renderer/chat/index.html`. (Supersedes the `KOK/WIN/AI` labels noted in
  the Kokoro entry below.)
- **Log the transcript text.** `src/main/audio.ts` logged only
  `Transcript received, length: N`; it now logs the transcript content too:
  `Transcript received (length N): <text>`.

**Verification**
- `npx tsc` exits 0.

---

### feat/kokorotts — Kokoro as a local, offline TTS provider
**Time:** ~13:50 (local, UTC+3)
**Branch:** `feat/kokorotts` (cut from `develop`)
**Author:** Claude Code

Added **Kokoro** as a fourth TTS provider alongside ElevenLabs / OpenAI /
Windows SAPI. Kokoro is an 82M-parameter open-weight neural TTS model
(Apache-2.0) that sounds far more natural than Windows SAPI yet runs **entirely
on-device** — no API key, no server, no Python, nothing leaves the machine. It
strengthens the existing offline/HIPAA story (whisper-local + local TTS). Uses
[`kokoro-js`](https://www.npmjs.com/package/kokoro-js) (maintained by
Xenova / Hugging Face) running the `onnx-community/Kokoro-82M-v1.0-ONNX` weights
through `onnxruntime-node` in the main process. All additions are additive —
default TTS provider is unchanged.

Deliberately **not** over-engineered: Kokoro's voice list is fixed and baked
into the model, so there is **no API-key / Test-connection / dynamic-fetch**
machinery (unlike Groq/Gemini) — just a static dropdown.

**New code**
- `src/services/tts/kokoro.ts` — `KokoroTTS implements TTSProvider`. The model
  loads **once per dtype** into a module-level `Map` cache (the TTS factory
  builds a fresh provider per request — the heavy model must not be; keying by
  dtype lets the Fast/Best quality toggle swap variants on demand without
  discarding the one already in memory). Loading is forced **fully offline**
  (`@huggingface/transformers` `env.allowRemoteModels = false`,
  `env.localModelPath` → the resources dir, `from_pretrained("kokoro", { dtype,
  device: "cpu" })`). `speak()` splits long text on sentence boundaries
  (`MAX_CHARS = 180`, under Kokoro's ~510-token phoneme limit) and **pipelines**
  generation with playback — it kicks off generation of the *next* chunk before
  playing the current one, so CPU inference overlaps playback instead of stacking
  after it (removes the gaps between sentences). Playback reuses the PowerShell
  `MediaPlayer` pattern from the OpenAI/ElevenLabs providers, with exact duration
  from the raw 24 kHz samples instead of the MP3 byte-estimate hack. `stop()`
  sets a flag (checked between chunks) and kills the current player process.

**Wiring**
- `src/services/tts/interface.ts` — added `case "kokoro"` to the factory
  (lazy `require("./kokoro")`, passes `kokoroVoice` + `Number(kokoroSpeed)` +
  `kokoroQuality`).
- `src/main/settings.ts` — extended `ttsProvider` union to include `"kokoro"`;
  added `kokoroVoice` (default `af_heart`), `kokoroSpeed` (default `1.0`), and
  `kokoroQuality` (`"fast"` | `"best"`, default `"fast"`).
- `src/main/companion.ts` — **no change**; `createTTSProvider()` already routes
  by `ttsProvider` and the spoken text already has POINT tags stripped.

**Model assets + packaging**
- `package.json` — added `kokoro-js` (`^1.2.1`); it pulls in
  `@huggingface/transformers` (which includes the native `onnxruntime-node`
  binary).
- `forge.config.ts` — `extraResource: ["resources/kokoro"]` bundles the model
  folder into packaged builds (lands at `process.resourcesPath/kokoro`, resolved
  the same way `whisper-local.ts` resolves its model). The existing
  `@electron-forge/plugin-auto-unpack-natives` handles the onnxruntime `.node`
  binary.
- `.gitignore` — ignore `resources/kokoro/` (weights downloaded separately, like
  the Whisper binaries). Contents: `config.json`, `tokenizer.json`,
  `tokenizer_config.json`, and **both** ONNX variants —
  `onnx/model_q4.onnx` (~305 MB, the q4 "Fast" variant) and
  `onnx/model_quantized.onnx` (~92 MB, the q8 "Best" variant). The **voices**
  ship inside the `kokoro-js` package itself, so they need no bundling.

**Settings UI — `src/renderer/settings/index.html`**
- New `Kokoro (offline, natural)` option in the Default Voice dropdown.
- New `kokoroGroup` field block, conditionally shown when the voice is Kokoro
  (new `updateTtsUI()` toggle, mirroring `updateProviderUI()`): a voice
  `<select>` with the 28 voices in `<optgroup>`s by accent/gender, a Speed
  slider (0.5×–2×) with a live value label, and a **Quality** select
  (Fast / Best). `kokoroVoice` / `kokoroSpeed` / `kokoroQuality` added to the
  `fields` array so the existing save/load handlers persist them.
- Added a `select optgroup` CSS rule (readable header color + slightly darker
  background) — the browser default rendered the group labels as dark text on
  the dark field, which was unreadable.

**Chat window — `src/renderer/chat/index.html`**
- The quick voice toggle is now 4-state: `off → Kokoro (KOK) → Windows (WIN) →
  OpenAI (AI) → off`, putting the recommended offline voice one click away.
  Load logic recognizes a saved `kokoro` provider (previously any non-OpenAI
  enabled provider was mislabeled "WIN").

**Bug fix (pre-existing)**
- `src/renderer/settings/index.html` — the HIPAA-mode handler targeted a
  non-existent `#ttsProvider` element (would throw); fixed to `#defaultVoice`,
  and it now keeps Kokoro or Windows (both local) rather than always forcing
  Windows.

**Docs**
- `docs/voice-and-tts.md` — added Kokoro (and the previously-missing OpenAI) to
  the TTS providers table, plus a "Using Kokoro (No Cloud)" section with the
  model-download layout and enable steps.
- `AGENTS.md` — added Kokoro to the `tts/` architecture line, an External
  binaries note (bundled model, offline load, singleton), and the offline/HIPAA
  security note.
- `docs/hipaa-mode.md` — TTS row now reads "Local only — Kokoro or Windows SAPI".

**Performance + quality follow-up (same session)**
First live run "lagged a lot". Two root causes, both fixed:
1. **Sequential generate→play→generate stacking.** Benchmarked on a 4-sentence
   reply (11.6 s of audio): old path took **24.2 s** wall (≈2× the audio, with
   gaps between sentences). Pipelining generation with playback (above) cut it
   to **14.9 s** with no gaps — basically audio length + first-chunk latency.
2. **q8 is slow on CPU.** Benchmarked q8 vs q4 on the user's Ryzen 5 3600
   (6c/12t) at steady state (warm-up excluded):

   | dtype | First-word | Gen for ~13 s audio | Realtime factor |
   |-------|-----------|---------------------|-----------------|
   | q8    | ~3.5 s    | 14.4 s              | 1.12× (slower than realtime) |
   | q4    | ~0.8 s    | 3.4 s               | **0.26× (≈4× faster)** |

   Counter-intuitively `model_q4.onnx` is *larger* on disk (305 MB vs 92 MB) but
   hits a much faster compute path. Decision (user): **ship both, add a
   Fast (q4) / Best (q8) quality toggle, default Fast.** With Fast + pipelining,
   first word lands in <1 s and playback is gapless.

**Verification**
- `npx tsc` (emit) and `eslint` on changed files all exit 0.
- Confirmed `kokoro-js` + `@huggingface/transformers` load under CommonJS
  `require` and the native onnxruntime binary initializes.
- **Live end-to-end** (Node probe mirroring `kokoro.ts`): both q4 and q8 load
  fully offline from `resources/kokoro` and `generate(...)` → valid 24 kHz WAV;
  benchmark numbers above measured on the real machine.
- Initial symptom — `Unknown TTS provider: kokoro` at runtime — was the stale
  `dist/` trap (`npm run dev` had loaded a pre-`tsc` build); resolved by running
  `npx tsc`.

**Out of scope (deferred)**
- Warm-up at app startup (load + silent inference when Kokoro is selected) to
  remove the first-reply cold-start. Considered; not done — Fast/q4 made the
  cold start small enough.
- Streaming synthesis (`kokoro-js` offers `stream()` / `TextSplitterStream`);
  the current per-sentence pipelined chunking matches the existing providers'
  approach and is already gapless.
- Non-English voices (the model ships many; the dropdown lists the 28
  English/American/British voices `kokoro-js` v1.2.1 exposes).

### feat/groq-stt — Google Gemini as an LLM provider
**Time:** ~12:07 (local, UTC+3)
**Branch:** `feat/groq-stt` (continued)
**Author:** Claude Code

Added **Google Gemini** as a first-class vision-LLM provider, alongside the
existing Anthropic / OpenAI / OpenRouter options. Fully configurable from the
UI: base URL, API key, model (dynamic dropdown), reasoning, temperature, and a
Test API connection button. Mirrors the existing provider pattern
(`openrouter-chat.ts`) and the Groq STT test-connection / dynamic-model-list
mechanism — no existing behaviour changed (default provider is still Anthropic;
all additions are additive). Uses the official
[`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK.

**New code**
- `src/services/gemini-chat.ts` — `GeminiChatService`. One `query()` call via
  `ai.models.generateContent`, screenshots passed as inline image parts
  (`inlineData` / `image/jpeg`), conversation history mapped to Gemini
  `contents` (`assistant` → `"model"`). Same POINT-tag system prompt as the
  other providers. No second-pass `refinePoint` (that stays Claude-only).
- **Reasoning** is unified behind one dropdown (Default / Off / Low / Medium /
  High). `buildThinkingConfig()` maps it to `thinkingLevel` for Gemini-3 models
  (`/gemini-3/` → MINIMAL/LOW/MEDIUM/HIGH) and to `thinkingBudget` for the 2.5
  series (0 / 1024 / 8192 / 24576). `Default` omits the config entirely.

**Wiring**
- `src/main/settings.ts` — extended `aiProvider` union to include `"gemini"`;
  added `geminiApiKey`, `geminiBaseUrl` (empty = SDK default
  `https://generativelanguage.googleapis.com`), `geminiModel`
  (default `gemini-3.5-flash`), `geminiReasoning` (default `"default"`),
  `geminiTemperature` (default `1`), and two cache fields
  (`geminiModelList`, `geminiModelListFetchedAt`).
- `src/main/companion.ts` — routes `aiProvider === "gemini"` to
  `GeminiChatService` in `getAIProvider()`.
- `package.json` — added `@google/genai` (`^2.8.0`) dependency.

**IPC + preload**
- `src/main/index.ts` — added `fetchGeminiModels` helper (GETs
  `${baseUrl}/v1beta/models?key=…`, keeps models supporting
  `generateContent`, strips the `models/` prefix, pins the default first) and
  the `settings:testGeminiKey` handler (verifies key + caches the list).
- `src/preload/index.ts` — exposed `testGeminiKey` to the renderer.

**Settings UI — `src/renderer/settings/index.html`**
- New Gemini API key field in the API Keys section, and a `Google (Gemini)`
  option in the AI Provider dropdown.
- New `geminiModelGroup`, conditionally shown when the provider is Gemini
  (same `updateProviderUI()` toggle pattern as the other model groups):
  base URL, dynamic model `<select>`, reasoning dropdown, temperature input,
  and a **Test API connection** button with inline ok/error feedback.
- Model dropdown is populated dynamically from the cached list
  (`renderGeminiModelDropdown`, clone of `renderGroqModelDropdown`), with
  `gemini-3.5-flash` pinned first. Test button refreshes it.

**Chat window first-run — `src/renderer/chat/index.html`**
- Added Gemini to the setup wizard: provider option, `key-gemini` field,
  static model list, badge/label handling, load + save logic, and included
  `geminiApiKey` in the "is configured?" check so a Gemini-only user can
  onboard without getting stuck. (Full base-URL / reasoning / temperature /
  test controls live in the Settings panel, consistent with how the other
  providers are handled in the wizard.)

**Docs**
- `CLAUDE.md` — added `gemini-chat.ts` to the architecture diagram and Gemini
  to the `AIProvider` list in the query-flow description.
- `README.md` — added Gemini to the multi-provider feature line and the
  services diagram.
- `SECURITY.md` — added Google Gemini to the "where screenshots go" row.

**Verification**
- `npx tsc` and `eslint` on all changed files both exit 0.
- Live API calls (Test connection, real query) require the user's Gemini key
  and the running GUI, so they were not exercised here.

**Out of scope (deferred)**
- Second-pass POINT refinement for Gemini (Claude-only today).
- Proxy support for Gemini requests (existing proxy is Claude-only).

### feat/groq-stt — Groq Whisper as the default STT provider
**Time:** ~11:35 → 12:01 (local, UTC+3)
**Branch:** `feat/groq-stt` (cut from `master` @ `c935b10`)
**Author:** opencode

Switched the default speech-to-text backend from AssemblyAI to
[Groq's Whisper Large V3 Turbo](https://console.groq.com/docs/speech-text)
endpoint. Groq's OpenAI-compatible STT API is fast, has a generous free
tier, and is the new out-of-the-box recommendation for new users.

**New code**
- `src/services/transcription/groq.ts` — `GroqTranscriptionProvider`.
  Batch transcription via `${baseUrl}/audio/transcriptions` with
  `temperature: 0`, `response_format: "verbose_json"`. Configurable
  `baseUrl` and `model` so a single implementation covers Groq Cloud,
  self-hosted gateways, and future model additions.

**Wiring**
- `src/services/transcription/interface.ts` — added `case "groq"` to the
  provider factory.
- `src/main/audio.ts` — added a Groq branch (with explicit "no API key
  configured" error message) and re-routed the OpenAI/AssemblyAI
  fallback so the old "if you have an OpenAI key, use it" last-resort
  path stays at the bottom.
- `src/main/settings.ts` — added `groqApiKey`, `groqBaseUrl`
  (default `https://api.groq.com/openai/v1`), `groqSttModel`
  (default `whisper-large-v3-turbo`), plus two cache fields
  (`groqSttModelList`, `groqSttModelListFetchedAt`). Default
  `transcriptionProvider` changed from `"assemblyai"` to `"groq"`.

**IPC + preload**
- `src/main/index.ts` — added `fetchGroqModels` helper and two
  handlers: `settings:testGroqKey` (verifies key + refreshes cache
  if stale) and `settings:refreshGroqModelList` (forces a refresh).
- `src/preload/index.ts` — exposed `testGroqKey` and
  `refreshGroqModelList` to the renderer.

**Settings UI — `src/renderer/settings/index.html`**
- New "Speech-to-Text (Groq)" section, conditionally shown only when
  `transcriptionProvider === "groq"` (mirrors the `claudeModelGroup`
  toggle pattern via a new `updateSttProviderUI()`).
- Fields: Groq API key (password), Groq base URL (text, pre-filled
  with the default), Groq model (dynamic `<select>`), Test API Key
  button.
- Model dropdown is populated dynamically from Groq's `/models`
  endpoint filtered to `id.includes("whisper")`, with
  `whisper-large-v3-turbo` always pinned first. An "Updated N days
  ago · click Test to refresh" hint sits underneath.
- **5-day TTL** on the cached model list. Refresh triggers:
  1. Clicking Test API Key (always; if cache is stale, list is
     refetched and the timestamp is bumped).
  2. Opening the settings panel (silent, non-blocking; same TTL
     check).
- Reordered the `transcriptionProvider` `<select>` so Groq is
  first, with "(default · recommended)" tag in the label.
- Added new styles: `.test` button, `.hint` / `.hint.ok` /
  `.hint.error` for the inline result line and model list hint.
- HIPAA toggle still forces `whisper-local` — no change.

**Chat window first-run — `src/renderer/chat/index.html`**
- Added `key-groq` to the optional-keys block. Save handler writes
  `groqApiKey` and auto-selects Groq as the transcription provider
  only when no other STT key is present. The base URL / model /
  test button stay in the full Settings panel (chat is keys-only,
  consistent with how OpenAI/AssemblyAI are handled).

**Docs**
- `docs/voice-and-tts.md` — added Groq to the providers table (top
  row, "default"), added a "Setting Up Groq Whisper" section with
  the API-key flow, free-tier note, base-URL override note, and a
  paragraph on the dynamic model dropdown.
- `docs/getting-started.md` — added Groq to the API keys table.
- `CLAUDE.md` — updated the architecture diagram and the audio
  pipeline description to list Groq as a transcription option.
- `README.md` — added Groq to the Setup keys list and the Voice
  Input features list.

**Out of scope (deferred)**
- Streaming/partial transcripts from Groq (no realtime STT endpoint
  on Groq side — batch only, same as OpenAI Whisper).
- Proxy support for Groq requests (existing proxy is Claude-only).
- Broader STT model-family filter (currently `id.includes("whisper")`
  — covers everything Groq lists today).

### Lint cleanup
**Time:** ~12:01 (local, UTC+3)
**Branch:** `feat/groq-stt` (continued)

`npm run lint` was broken on `master` — the repo had
`@typescript-eslint` packages installed but no ESLint config file at
all, so ESLint 9's "couldn't find an eslint.config" error tripped
immediately. Fixed it on this branch so the lint gate is meaningful
going forward.

- **`eslint.config.js`** (new) — ESLint 9 flat config using
  `FlatCompat` from `@eslint/eslintrc` to extend
  `plugin:@typescript-eslint/recommended`. Ignores `dist/`, `out/`,
  `node_modules/`, `.webpack/`, `release/`, `*.d.ts`.
- **`package.json`** — dropped the deprecated `--ext .ts,.tsx` flag
  from the `lint` and `lint:fix` scripts (ESLint v9 removed it; the
  config's `files` patterns handle file selection now).
- **`src/services/transcription/interface.ts`** and
  **`src/services/tts/interface.ts`** — file-level
  `/* eslint-disable @typescript-eslint/no-require-imports */`
  since both files use `require()` deliberately for lazy provider
  loading (unchanged behaviour, just ESLint-quiet).
- **`src/main/audio.ts`** — per-line
  `// eslint-disable-next-line @typescript-eslint/no-require-imports`
  for the new Groq `require()`.
- **`src/main/companion.ts`** — removed pre-existing dead var
  `ttsProv` (assigned, never used).
- **`src/main/index.ts`** — removed pre-existing dead var `tray`
  (assigned, never used).

`npm run lint` and `npm run typecheck` both exit 0 after these
changes.
