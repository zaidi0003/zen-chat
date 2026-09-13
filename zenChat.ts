// ============================================================
// Zen Chat — يتواصل مع OpenCode Zen بدون أي تسجيل (anonymous)
// Based on opencode v1.18.30 (github.com/sst/opencode)
//
// - يحتوي سكريبت إنشاء الجلسة (session id) منقول من
//   packages/opencode/src/id/id.ts في opencode (ses_ + 26 حرف base62)
// - يستخدم نفس هيدرز opencode لـ Zen:
//   x-opencode-session / x-opencode-request / x-opencode-client / User-Agent
// - المفتاح المجهول "public" هو المسار الرسمي للموديلات المجانية
// - retry ذكي: عند 429/5xx ينتظر backoff تصاعدي ويعيد المحاولة،
//   وإذا استمر الحد يجرّب موديلًا مجانيًا آخر من القائمة
//
// الموديلات المجانية المتاحة بدون تسجيل (تم اختبارها فعليًا):
//   nemotron-3-ultra-free, nemotron-3.5-lightning-free,
//   mimo-v2.5-free, ling-3.0-flash-fin-free
//
// API:
//   POST { message, sessionId?, model?, messages?, stream?, system? }
//   GET  => قائمة الموديلات المتاحة
// ============================================================

const VERSION = "1.18.30";
const USER_AGENT = `opencode/${VERSION}`;
const ZEN_BASE = "https://opencode.ai/zen"; // zen/v1 = القائمة الكاملة (فيها الموديلات -free)
const ANON_KEY = "public"; // المفتاح المجهول الرسمي
const DEFAULT_MODEL = "nemotron-3-ultra-free";

// موديلات مجانية مجربة وشغالة بدون تسجيل (الترتيب = أولوية الفالينغ-أوف)
const FREE_MODELS = [
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "ling-3.0-flash-fin-free",
  "mimo-v2.5-free",
];

// إعدادات retry: backoff تصاعدي 4s ثم 10s ثم 20s
const RETRY_DELAYS_MS = [4000, 10000, 20000];

// ------------------------------------------------------------
// سكريبت إنشاء الجلسة — منقول من opencode: packages/opencode/src/id/id.ts
// ------------------------------------------------------------
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < length; i++) result += ID_ALPHABET[bytes[i] % 62];
  return result;
}

function createSessionID(): string {
  // نفس منطق opencode: timestamp بالمللي ثانية مرمّز base62 + جزء عشوائي
  const now = BigInt(Date.now()) * BigInt(0x1000);
  let num = now;
  let timePart = "";
  if (num > 0n) {
    while (num > 0n) {
      timePart = ID_ALPHABET[Number(num % 62n)] + timePart;
      num = num / 62n;
    }
  } else {
    timePart = "0";
  }
  const randLen = Math.max(0, 26 - timePart.length);
  return `ses_${timePart}${randLen > 0 ? randomBase62(randLen) : ""}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------
// قائمة الموديلات من Zen
// ------------------------------------------------------------
async function listModels(): Promise<string[]> {
  const res = await fetch(`${ZEN_BASE}/v1/models`, {
    headers: {
      "Authorization": `Bearer ${ANON_KEY}`,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({ data: [] }));
  return (data?.data ?? []).map((m: { id: string }) => m.id);
}

// ------------------------------------------------------------
// استدعاء Zen API (متوافق OpenAI) — مع retry وbackoff
// ------------------------------------------------------------
async function callZen(
  { messages, model, stream, sessionId }: {
    messages: { role: string; content: string }[];
    model: string;
    stream: boolean;
    sessionId: string;
  },
): Promise<{ res: Response; raw: string; attempts: number; rateLimited: boolean }> {
  const url = `${ZEN_BASE}/v1/chat/completions`;
  const requestId = randomBase62(20);

  const body: Record<string, unknown> = { model, messages, stream };
  if (stream) body["stream_options"] = { include_usage: true };

  let attempts = 0;
  let rateLimited = false;

  // backoff تصاعدي: 4s ثم 10s ثم 20s
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    attempts++;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ANON_KEY}`,
        "Content-Type": "application/json",
        // نفس الهيدرز التي يرسلها opencode لـ Zen
        "x-opencode-session": sessionId,
        "x-opencode-request": randomBase62(20),
        "x-opencode-client": "opencode",
        "User-Agent": USER_AGENT,
        "HTTP-Referer": "https://opencode.ai/",
        "X-Title": "opencode",
      },
      body: JSON.stringify(body),
    });

    // نجاح أو خطأ غير قابل للإعادة (4xx ما عدا 429)
    if (res.ok || (res.status < 500 && res.status !== 429)) {
      return { res, raw: "", attempts, rateLimited };
    }

    rateLimited = res.status === 429;
    const raw = await res.text();

    // آخر محاولة؟ أرجع الخطأ كما هو
    if (i === RETRY_DELAYS_MS.length) {
      return { res, raw, attempts, rateLimited };
    }

    // انتظر قبل المحاولة التالية (مع jitter بسيط)
    const jitter = Math.floor(Math.random() * 1000);
    await sleep(RETRY_DELAYS_MS[i] + jitter);
    console.log(`zenChat: retry ${attempts} after ${RETRY_DELAYS_MS[i]}ms (status ${res.status})`);
  }

  return { res: new Response("unreachable", { status: 500 }), raw: "", attempts, rateLimited };
}

// ------------------------------------------------------------
// المعالج الرئيسي
// ------------------------------------------------------------
Deno.serve(async (req) => {
  try {
    // GET: قائمة الموديلات (المجانية المتاحة + الكاملة)
    if (req.method === "GET") {
      const all = await listModels();
      return new Response(
        JSON.stringify({
          ok: true,
          freeAnonymousModels: FREE_MODELS, // شغالة بدون تسجيل
          totalModels: all.length,
          models: all,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    let input: Record<string, unknown> = {};
    try {
      input = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: {"Content-Type":"application/json"},
      });
    }

    // إنشاء معرف الجلسة (أو استخدام المرسل) — سكريبت opencode نفسه
    const sessionId = typeof input.sessionId === "string" && input.sessionId.startsWith("ses_")
      ? input.sessionId
      : createSessionID();

    // بناء سجل المحادثة
    const history = Array.isArray(input.messages) ? input.messages : [];
    const messages: { role: string; content: string }[] = history
      .filter((m: Record<string, unknown>) => typeof m?.role === "string" && typeof m?.content === "string")
      .map((m: Record<string, unknown>) => ({ role: String(m.role), content: String(m.content) }));

    if (typeof input.system === "string" && input.system) {
      messages.unshift({ role: "system", content: input.system });
    }

    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (message) messages.push({ role: "user", content: message });

    if (messages.length === 0) {
      return new Response(JSON.stringify({ error: "Provide 'message' or 'messages'" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const requestedModel = typeof input.model === "string" && input.model ? input.model : DEFAULT_MODEL;
    const stream = input.stream === true;

    // stream=true: نمرر SSE كما هو (بدون retry حتى لا يتضاعف الاستهلاك)
    if (stream) {
      const res = await fetch(`${ZEN_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ANON_KEY}`,
          "Content-Type": "application/json",
          "x-opencode-session": sessionId,
          "x-opencode-request": randomBase62(20),
          "x-opencode-client": "opencode",
          "User-Agent": USER_AGENT,
          "HTTP-Referer": "https://opencode.ai/",
          "X-Title": "opencode",
        },
        body: JSON.stringify({ model: requestedModel, messages, stream: true, stream_options: { include_usage: true } }),
      });
      if (!res.ok && !res.body) {
        const err = await res.text();
        return new Response(err, { status: res.status, headers: { "Content-Type": "application/json" } });
      }
      return new Response(res.body, {
        status: res.status,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    // stream=false مع retry وfallback
    // قائمة الموديلات للمحاولة: المطلوب أولًا، ثم بقية المجانية (إذا كان المطلوب مجانيًا)
    const modelsToTry = [requestedModel];
    if (FREE_MODELS.includes(requestedModel)) {
      modelsToTry.push(...FREE_MODELS.filter((m) => m !== requestedModel));
    }

    const errors: unknown[] = [];
    for (const model of modelsToTry) {
      const { res, raw, attempts, rateLimited } = await callZen({ messages, model, stream: false, sessionId });
      const text = raw || (await res.text());

      if (res.ok) {
        const data = JSON.parse(text);
        const reply = data?.choices?.[0]?.message?.content ?? "";
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId, // أرجِم الجلسة ليستمر بناء المحادثة بها في الطلبات التالية
            model,
            requestedModel,
            fallbackUsed: model !== requestedModel,
            attempts,
            reply,
            usage: data?.usage ?? undefined,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      errors.push({ model, status: res.status, detail: safeJson(text) });

      // 429 بعد كل الـ retries: جرّب الموديل المجاني التالي
      // خطأ آخر (400/403...): لا داعي للتجربة — نفس الطلب سيفشل
      if (!rateLimited) break;
    }

    return new Response(
      JSON.stringify({
        error: "Zen API error",
        tried: modelsToTry.slice(0, errors.length),
        errors,
        hint: "الحد المجهول (per-IP) مؤقت — أعد المحاولة بعد دقيقة، أو أنشئ مفتاحًا مجانيًا من opencode.ai/auth لرفع الحد",
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}
