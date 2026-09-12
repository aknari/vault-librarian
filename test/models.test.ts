/**
 * Model-dropdown tests. Run with: npm test
 *
 * Two things must stay true: the free-tier hint is only a *label* (it never
 * filters anything out), and the model you already have selected is always in
 * the list and marked as such — otherwise opening the settings could silently
 * change your model to whatever the dropdown happens to show first.
 */
import assert from 'node:assert/strict';
import {
  buildModelChoices,
  isChatCapable,
  isFreeTierModel,
  isHiddenModel,
  modelLabel,
  orderModels,
} from '../src/models';

const DEFAULT = ['flash', '!tts', '!image'];
const GEMINI = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-embedding-001'];

let failed = 0;
const check = (desc: string, got: unknown, expected: unknown): void => {
  try {
    assert.deepStrictEqual(got, expected);
    console.log(`  ok   ${desc}`);
  } catch {
    failed += 1;
    console.error(`  FAIL ${desc}\n       got ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
};

// --- the hint -----------------------------------------------------------------
check('flash is free by default', isFreeTierModel('gemini-2.5-flash', DEFAULT), true);
check('flash-lite is free by default', isFreeTierModel('gemini-2.5-flash-lite', DEFAULT), true);
check('pro is not', isFreeTierModel('gemini-2.5-pro', DEFAULT), false);
check('embeddings are not', isFreeTierModel('gemini-embedding-001', DEFAULT), false);
check('the match ignores case', isFreeTierModel('Gemini-2.5-FLASH', DEFAULT), true);
check('patterns are matched as substrings', isFreeTierModel('gemini-3-flash-preview', ['flash']), true);
check('an empty pattern list stops the labelling', isFreeTierModel('gemini-2.5-flash', []), false);
check('blank lines in the patterns are ignored', isFreeTierModel('gemini-2.5-flash', ['', '  ']), false);
check('extra patterns work', isFreeTierModel('llama3.2', ['llama']), true);
// A `!` line is an exclusion and wins over the inclusions: the speech and image
// variants carry `flash` in their name but are not chat models.
check('!tts excludes a flash model', isFreeTierModel('gemini-2.5-flash-preview-tts', DEFAULT), false);
check('!image excludes its flash variant', isFreeTierModel('gemini-2.5-flash-image', DEFAULT), false);
check('the exclusion does not hit a plain flash', isFreeTierModel('gemini-2.5-flash', DEFAULT), true);
check('an exclusion alone excludes nothing but also marks nothing', isFreeTierModel('gemini-2.5-flash', ['!tts']), false);
check('a lone ! matches everything, so it excludes everything', isFreeTierModel('anything', ['!']), false);

// --- ordering -----------------------------------------------------------------
check(
  'free models come first, then alphabetical',
  orderModels(GEMINI, DEFAULT),
  ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-embedding-001'],
);
check('duplicates collapse', orderModels(['b', 'a', 'b'], []), ['a', 'b']);
check('empty names are dropped', orderModels(['a', '', 'b'], []), ['a', 'b']);
check(
  'the current model is kept even when it is not free',
  orderModels(['gemini-2.5-pro', 'gemini-2.5-flash'], DEFAULT).includes('gemini-2.5-pro'),
  true,
);
check(
  'and with no patterns nothing is marked free',
  orderModels(['b', 'a'], []),
  ['a', 'b'],
);

// --- labels -------------------------------------------------------------------
check('a plain model is just its name', modelLabel('gemini-2.5-pro', DEFAULT, false), 'gemini-2.5-pro');
check('free is marked', modelLabel('gemini-2.5-flash', DEFAULT, false), 'gemini-2.5-flash  · free tier');
check('the current one is marked', modelLabel('gemini-2.5-pro', DEFAULT, true), 'gemini-2.5-pro  · current');
check(
  'both marks can appear',
  modelLabel('gemini-2.5-flash', DEFAULT, true),
  'gemini-2.5-flash  · free tier · current',
);
check('no patterns, no free mark', modelLabel('gemini-2.5-flash', [], true), 'gemini-2.5-flash  · current');

// --- what the provider declares (a fact) ---------------------------------------
// Groq goes beyond the OpenAI spec: a text-to-speech model answers `['speech']`
// and Whisper `['transcription']`.
check('a text-out model is a chat model', isChatCapable({ output_modalities: ['text'] }), true);
check('a speech model is not', isChatCapable({ output_modalities: ['speech'] }), false);
check('a transcription model is not', isChatCapable({ output_modalities: ['transcription'] }), false);
check('the modality is matched whatever the case', isChatCapable({ output_modalities: ['TEXT'] }), true);
check(
  'image in, text out is still chat',
  isChatCapable({ input_modalities: ['text', 'image'], output_modalities: ['text'] }),
  true,
);
// Silence is not evidence: LM Studio, Ollama and most gateways declare nothing.
check('a provider that declares nothing is kept', isChatCapable({ id: 'llama3.2' }), true);
check('an empty modality list means "nothing declared"', isChatCapable({ output_modalities: [] }), true);
check('a non-array modality field is ignored', isChatCapable({ output_modalities: 'text' }), true);

// --- what you prefer not to see (a preference) ---------------------------------
const HIDE = ['whisper', 'tts', 'orpheus', 'embed', 'rerank', 'guard'];
check('whisper is hidden', isHiddenModel('whisper-large-v3', HIDE), true);
check('a TTS model is hidden', isHiddenModel('canopylabs/orpheus-v1-english', HIDE), true);
check('an embedding model is hidden', isHiddenModel('nomic-embed-text', HIDE), true);
check('a re-ranker is hidden', isHiddenModel('bge-reranker-v2', HIDE), true);
check('a prompt-guard classifier is hidden', isHiddenModel('meta-llama/llama-prompt-guard-2-22m', HIDE), true);
// "safeguard" contains "guard": the classifier goes, and `!safeguard` gets it back.
check('the safeguard model is hidden too', isHiddenModel('openai/gpt-oss-safeguard-20b', HIDE), true);
check('`!safeguard` brings it back', isHiddenModel('openai/gpt-oss-safeguard-20b', [...HIDE, '!safeguard']), false);
check('a chat model is kept', isHiddenModel('qwen/qwen3.8-27b', HIDE), false);
check('an empty list hides nothing', isHiddenModel('whisper-large-v3', []), false);

// --- the real Groq catalogue (14 models) ---------------------------------------
// Recorded from GET https://api.groq.com/openai/v1/models. Kept as a fixture so
// the rule is documented; if Groq changes its catalogue, the rule still holds.
const GROQ: Array<{ id: string; output_modalities: string[] }> = [
  { id: 'openai/gpt-oss-120b', output_modalities: ['text'] },
  { id: 'canopylabs/orpheus-v1-english', output_modalities: ['speech'] },
  { id: 'meta-llama/llama-prompt-guard-2-22m', output_modalities: ['text'] },
  { id: 'qwen/qwen3.8-27b', output_modalities: ['text'] },
  { id: 'qwen/qwen3.6-27b', output_modalities: ['text'] },
  { id: 'whisper-large-v3', output_modalities: ['transcription'] },
  { id: 'whisper-large-v3-turbo', output_modalities: ['transcription'] },
  { id: 'canopylabs/orpheus-arabic-saudi', output_modalities: ['speech'] },
  { id: 'groq/compound', output_modalities: ['text'] },
  { id: 'openai/gpt-oss-20b', output_modalities: ['text'] },
  { id: 'allam-2-7b', output_modalities: ['text'] },
  { id: 'openai/gpt-oss-safeguard-20b', output_modalities: ['text'] },
  { id: 'groq/compound-mini', output_modalities: ['text'] },
  { id: 'meta-llama/llama-prompt-guard-2-86m', output_modalities: ['text'] },
];
const chatCapable = GROQ.filter(isChatCapable).map(entry => entry.id);
check('Groq: the 4 audio models go by modality', chatCapable.length, 10);
check(
  'Groq: and the 3 classifiers go by pattern',
  chatCapable.filter(id => !isHiddenModel(id, HIDE)),
  [
    'openai/gpt-oss-120b',
    'qwen/qwen3.8-27b',
    'qwen/qwen3.6-27b',
    'groq/compound',
    'openai/gpt-oss-20b',
    'allam-2-7b',
    'groq/compound-mini',
  ],
);

// --- the dropdown ---------------------------------------------------------------
const choices = buildModelChoices('qwen/qwen3.8-27b', chatCapable, { hidePatterns: HIDE, freePatterns: [] });
check('a hidden model is not offered', choices.models.includes('llama-prompt-guard-2-22m'), false);
check('the hidden ones are reported, to be able to say how many', choices.hidden.length, 3);
check('the count is of everything fetched, before hiding', choices.offered, 10);
check(
  'and the ones that can chat are offered',
  choices.models,
  [
    'allam-2-7b',
    'groq/compound',
    'groq/compound-mini',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.6-27b',
    'qwen/qwen3.8-27b',
  ],
);
check(
  'the current model is offered even if a pattern hides it',
  buildModelChoices('whisper-large-v3', ['whisper-large-v3', 'qwen/qwen3.8-27b'], {
    hidePatterns: HIDE,
    freePatterns: [],
  }).models.includes('whisper-large-v3'),
  true,
);

if (failed > 0) {
  console.error(`\n${failed} model check(s) failed.`);
  process.exit(1);
}
console.log('\nmodel checks passed.');
