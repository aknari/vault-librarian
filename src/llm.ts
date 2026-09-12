import { requestUrl } from 'obsidian';
import { isChatCapable } from './models';
import type { LibrarianSettings } from './settings';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface LlmResponse {
  status: number;
  json: any;
  text: string;
  headers: Record<string, string>;
}

/**
 * Calls the configured provider with temperature 0 (reproducibility) and
 * retries on 429 honouring `retry-after`, which the Groq free tier does use.
 */
export async function askLlm(
  settings: LibrarianSettings,
  apiKey: string,
  prompt: string,
  purpose = 'task',
  maxRetries = 3,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await call(settings, apiKey, prompt);
      if (res.status === 429) {
        const wait = retryAfterSeconds(res.headers, attempt);
        console.error(`Vault Librarian: rate limited (${purpose}), waiting ${wait}s`);
        await sleep(wait * 1000);
        lastError = new Error(`Rate limited (429) on "${purpose}"`);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`LLM API error ${res.status}: ${res.text.slice(0, 300)}`);
      }
      return extractText(settings, res, purpose);
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes('429') || attempt === maxRetries) break;
      await sleep(retryAfterSeconds({}, attempt) * 1000);
    }
  }
  throw new Error(
    `LLM call failed (${purpose}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Turns a non-2xx answer into an error that repeats what the provider said.
 *
 * The model list doubles as the check behind "Save & test", so swallowing the
 * status here used to report a rejected key as a plugin with zero models —
 * which looks like success and hides a 401.
 */
function httpError(res: LlmResponse, what: string): Error {
  const body = res.json as { error?: { message?: string }; message?: string } | null;
  const detail = String(body?.error?.message ?? body?.message ?? res.text ?? '').trim();
  return new Error(`${what} failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
}

function retryAfterSeconds(headers: Record<string, string>, attempt: number): number {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 90);
  return Math.min(15 * (attempt + 1), 60); // 15s, 30s, 45s...
}

async function call(settings: LibrarianSettings, apiKey: string, prompt: string): Promise<LlmResponse> {
  if (settings.provider === 'google') {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    return requestUrl({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      }),
      throw: false,
    });
  }

  const base = settings.baseUrl.replace(/\/+$/, '');
  return requestUrl({
    url: `${base}/chat/completions`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
    throw: false,
  });
}

function extractText(settings: LibrarianSettings, res: LlmResponse, purpose: string): string {
  if (settings.provider === 'google') {
    const parts = res.json?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? (parts as Array<{ text?: string }>).map(p => p.text ?? '').join('')
      : '';
    if (!text) throw new Error(`Empty response from Gemini (${purpose})`);
    return text;
  }
  const content = res.json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) {
    throw new Error(`Empty response from the LLM API (${purpose})`);
  }
  return content;
}

/**
 * Lists the models the provider offers for chatting, for the Model dropdown.
 * Google returns everything it serves — embeddings, image, speech — and only
 * the `generateContent` ones can answer a prompt, so the rest is dropped.
 */
export async function listModels(settings: LibrarianSettings, apiKey: string): Promise<string[]> {
  if (settings.provider === 'google') {
    const res = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      method: 'GET',
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw httpError(res, 'listing the Gemini models');
    const models: Array<{ name?: string; supportedGenerationMethods?: string[] }> = res.json?.models ?? [];
    return models
      .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map(m => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  const base = settings.baseUrl.replace(/\/+$/, '');
  const res = await requestUrl({
    url: `${base}/models`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) throw httpError(res, `listing the models at ${base}`);
  // Groq (and a few gateways) go beyond the OpenAI spec and declare
  // `output_modalities`, which is what tells a speech or transcription model
  // apart from a chat model. Providers that declare nothing are kept as they
  // come — only the *preference* filter (`hiddenModelPatterns`) is applied when
  // the list is drawn, so editing it does not need a new request.
  const entries: Array<{ id?: string; output_modalities?: unknown }> = res.json?.data ?? [];
  return entries.filter(isChatCapable).map(entry => entry.id ?? '').filter(Boolean);
}
