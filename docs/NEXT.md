# Next

Short list of things worth doing soon, in rough priority order.

- **Stream the LLM response.** Today every LLM call (`claude.ts`, `openai-chat.ts`, `openrouter-chat.ts`) is a buffered `await response.json()` — we wait for the full reply before POINT-tag parsing, 2-pass refinement, and TTS even start. Switching to `stream: true` + SSE would let us start pointing and speaking the first sentence while the model is still generating, which is the obvious latency win in the user-perceived loop. Only AssemblyAI's WebSocket is actually streaming today; the ElevenLabs "low-latency streaming" comment in `tts/elevenlabs.ts:9` is misleading — the audio is buffered via `response.arrayBuffer()` and written to a temp file before playback.
