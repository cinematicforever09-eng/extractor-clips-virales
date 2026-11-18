/**
 * Ollama integration.
 *
 * Replaces the cloud model for the parts of the job that need language
 * judgement: picking which moments are worth clipping, and writing the title,
 * hook and social copy. Everything runs on this machine, so there is no API
 * key, no quota and no per-request cost.
 *
 * Ollama is optional. When it is not running, the caller falls back to the
 * heuristic clip finder, which still produces usable cuts from the transcript -
 * it just cannot write copy.
 */

const DEFAULT_HOST = 'http://127.0.0.1:11434';

/** Preference order; the first installed model wins. */
const PREFERRED_MODELS = [
  'qwen2.5:14b',
  'qwen2.5:7b',
  'llama3.1:8b',
  'mistral-nemo',
  'gemma2:9b',
];

function host(): string {
  return (process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/$/, '');
}

export interface OllamaStatus {
  available: boolean;
  models: string[];
  chosenModel: string | null;
}

let cachedStatus: OllamaStatus | null = null;
let cachedAt = 0;

/**
 * Checks whether Ollama is reachable and which model to use.
 *
 * Cached briefly: this is called on every health check and analysis, and a
 * failing connection otherwise costs a full timeout each time.
 */
export async function getOllamaStatus(force = false): Promise<OllamaStatus> {
  const CACHE_MS = 15_000;
  if (!force && cachedStatus && Date.now() - cachedAt < CACHE_MS) return cachedStatus;

  const empty: OllamaStatus = { available: false, models: [], chosenModel: null };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    const response = await fetch(`${host()}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      cachedStatus = empty;
      cachedAt = Date.now();
      return empty;
    }

    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => Boolean(name));

    const explicit = process.env.OLLAMA_MODEL;
    const chosenModel =
      (explicit && models.find((m) => m === explicit || m.startsWith(`${explicit}:`))) ||
      PREFERRED_MODELS.map((pref) =>
        models.find((m) => m === pref || m.startsWith(`${pref.split(':')[0]}:`))
      ).find(Boolean) ||
      models[0] ||
      null;

    cachedStatus = { available: models.length > 0, models, chosenModel };
    cachedAt = Date.now();
    return cachedStatus;
  } catch {
    cachedStatus = empty;
    cachedAt = Date.now();
    return empty;
  }
}

export function resetOllamaCache(): void {
  cachedStatus = null;
  cachedAt = 0;
}

export class OllamaUnavailableError extends Error {
  constructor() {
    super(
      'Ollama no está disponible. Instálalo desde ollama.com y descarga un modelo (por ejemplo: ollama pull qwen2.5:7b).'
    );
    this.name = 'OllamaUnavailableError';
  }
}

export interface GenerateJsonOptions {
  system?: string;
  prompt: string;
  /** JSON Schema passed to Ollama's structured output. */
  schema?: Record<string, unknown>;
  /** Local models can be slow; a long clip list needs room. */
  timeoutMs?: number;
  /** Context window in tokens. Raise it for prompts that carry long lists. */
  numCtx?: number;
  temperature?: number;
  /** Sampling seed. Fixed by default so the same input gives the same answer. */
  seed?: number;
}

/**
 * Asks the local model for a JSON answer.
 *
 * `format` takes a JSON Schema in current Ollama builds and the string "json"
 * in older ones. The schema is sent when provided and the result is parsed
 * defensively either way, because a local model is more likely than a hosted
 * one to wrap its answer in prose or a code fence.
 */
export async function generateJson<T>(options: GenerateJsonOptions): Promise<T> {
  const status = await getOllamaStatus();
  if (!status.available || !status.chosenModel) throw new OllamaUnavailableError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);

  try {
    const response = await fetch(`${host()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: status.chosenModel,
        /**
         * Streamed, which is not about showing progress - it is the only way
         * the request survives a long generation.
         *
         * With stream:false Ollama sends no response headers at all until the
         * whole answer is generated, and Node's HTTP client gives up waiting
         * for headers after 300 s no matter what AbortSignal you hand fetch.
         * Judging forty windows on a 7B model goes past that, so the call died
         * with UND_ERR_HEADERS_TIMEOUT and the app fell back to template copy
         * without saying so - seen on a real six-hour video. Streaming sends
         * the headers immediately, so only the overall timeout below applies.
         */
        stream: true,
        format: options.schema ?? 'json',
        options: {
          temperature: options.temperature ?? 0.7,
          /**
           * A fixed seed, so analysing the same video twice gives the same
           * clips. Without it every run sampled differently and the user saw
           * a different set of clips each time they sent the same video -
           * which reads as the app being unreliable, and makes it impossible
           * to tell whether a change actually improved anything.
           */
          seed: options.seed ?? 42,
          /**
           * Context window, set explicitly because the default is far too
           * small for what this app sends.
           *
           * `ollama ps` reported CONTEXT 4096 for qwen2.5:7b. A ranking
           * prompt carrying forty transcript windows runs past ten thousand
           * tokens, so most of the list was being dropped before the model
           * ever saw it - which is why entries came back unjudged and why the
           * call crawled. qwen2.5 handles 32k; 8192 is enough for the batch
           * sizes used here without spending VRAM on a window nothing fills.
           */
          num_ctx: options.numCtx ?? 8192,
        },
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          { role: 'user', content: options.prompt },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama respondió ${response.status}. ${detail.slice(0, 200)}`);
    }

    // NDJSON: one object per line, each carrying the next slice of content.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Ollama no devolvió cuerpo de respuesta.');

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let failure: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Keep the trailing fragment: a chunk can split a line in half.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const chunk = JSON.parse(trimmed) as {
            message?: { content?: string };
            error?: string;
          };
          if (chunk.error) failure = chunk.error;
          content += chunk.message?.content ?? '';
        } catch {
          // A malformed line is not worth failing the whole generation over.
        }
      }
    }

    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim()) as { message?: { content?: string } };
        content += chunk.message?.content ?? '';
      } catch {
        /* nothing usable in the tail */
      }
    }

    if (failure) throw new Error(`Ollama respondió con error: ${failure.slice(0, 200)}`);

    return parseLooseJson<T>(content);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        'El modelo local tardó demasiado. Prueba con un modelo más pequeño o un video más corto.'
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How fast the local model is actually generating, in tokens per second.
 *
 * Worth measuring because the number moves by orders of magnitude depending
 * on what else is using the GPU, and the failure is invisible from inside the
 * app. Measured on this machine with a game running: **0.1 tokens per
 * second**, against the 30-60 the same model does on an idle RTX 3080. At
 * that rate every call times out and the app quietly falls back to template
 * titles - which reads to the user as "the AI wrote bad copy" rather than
 * "the GPU is busy playing Call of Duty".
 *
 * The giveaway in the numbers is that prompt evaluation stays instant while
 * generation crawls: the weights have spilled out of VRAM into shared system
 * memory, so every token waits on the PCIe bus.
 *
 * Cached, because the probe itself is slow exactly when things are bad.
 */
let speedProbe: { at: number; tokensPerSecond: number | null } | null = null;
const SPEED_PROBE_TTL_MS = 120_000;

export async function measureOllamaSpeed(): Promise<number | null> {
  if (speedProbe && Date.now() - speedProbe.at < SPEED_PROBE_TTL_MS) {
    return speedProbe.tokensPerSecond;
  }

  const status = await getOllamaStatus();
  if (!status.available || !status.chosenModel) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`${host()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: status.chosenModel,
        stream: false,
        options: { num_predict: 8, temperature: 0 },
        messages: [{ role: 'user', content: 'Di solamente: hola' }],
      }),
    });

    const data = (await response.json()) as { eval_count?: number; eval_duration?: number };
    const tokens = data.eval_count ?? 0;
    const seconds = (data.eval_duration ?? 0) / 1e9;
    const rate = tokens > 0 && seconds > 0 ? tokens / seconds : null;

    speedProbe = { at: Date.now(), tokensPerSecond: rate };
    return rate;
  } catch {
    // Not finishing eight tokens in twelve seconds is itself the answer.
    speedProbe = { at: Date.now(), tokensPerSecond: 0 };
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerates code fences and surrounding prose around the JSON body. */
export function parseLooseJson<T>(raw: string): T {
  const text = raw.trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    /* try harder below */
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* keep going */
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as T;
    } catch {
      /* fall through */
    }
  }

  throw new Error('El modelo local no devolvió un JSON válido.');
}
