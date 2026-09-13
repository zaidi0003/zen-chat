# zen-chat

دالة backend للاتصال بموديلات **OpenCode Zen** المجانية **بدون أي تسجيل** — وصول مجهول عبر المفتاح الرسمي `public`.

> Ported from [opencode](https://github.com/sst/opencode) v1.18.30 — session-id script from `packages/opencode/src/id/id.ts`, same Zen headers (`x-opencode-session`, `x-opencode-client`, ...).

## Free models that work anonymously (tested live)

| Model | Notes |
|---|---|
| `nemotron-3-ultra-free` | default — strongest of the free tier |
| `nemotron-3.5-lightning-free` | fast |
| `ling-3.0-flash-fin-free` | fast, finetuned |
| `mimo-v2.5-free` | fallback |

⚠️ Anonymous access is **per-IP rate limited** (`FreeUsageLimitError`). The function retries with exponential backoff (4s → 10s → 20s) and falls back to the next free model. For higher limits, create a free API key at <https://opencode.ai/auth> (per-key limits instead of per-IP).

## Features

- ✅ No registration, no API key required (anonymous tier)
- ✅ Session-id generation — identical to opencode's own (`ses_` + 26 base62 chars, timestamp-encoded)
- ✅ Same headers opencode CLI sends to Zen
- ✅ OpenAI-compatible API
- ✅ Retry with backoff + automatic free-model fallback
- ✅ Streaming (SSE pass-through) supported

## Deploy (Base44 backend function / Deno)

Copy `zenChat.ts` to `functions/zenChat.ts` and deploy. Or run anywhere Deno runs.

## API

### `GET /functions/zenChat`
Lists available models.

### `POST /functions/zenChat`
```json
{
  "message": "مرحبا",
  "model": "nemotron-3-ultra-free",
  "sessionId": "ses_...",
  "messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
  "system": "أنت مساعد مفيد",
  "stream": false
}
```

Response:
```json
{
  "ok": true,
  "sessionId": "ses_...",
  "model": "nemotron-3-ultra-free",
  "requestedModel": "nemotron-3-ultra-free",
  "fallbackUsed": false,
  "attempts": 1,
  "reply": "...",
  "usage": {"prompt_tokens": 27, "completion_tokens": 48, "total_tokens": 75}
}
```

Reuse the returned `sessionId` in follow-up requests to keep the conversation sticky (same routing as opencode).

## License

MIT — the ported session-id script originates from the MIT-licensed [sst/opencode](https://github.com/sst/opencode).
