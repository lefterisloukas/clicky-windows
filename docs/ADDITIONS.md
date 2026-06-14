# Additions Log

Chronological record of features, fixes, and changes added to the project.
Each entry is dated and time-stamped (local time, `Europe/Istanbul` / UTC+3
unless otherwise noted). Newest entries go at the top.

---

## 2026-06-14

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
