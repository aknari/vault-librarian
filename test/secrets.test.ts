/**
 * Secret-storage tests. Run with: npm test
 *
 * These exist because of a real failure: the plugin used the id
 * `vaultLibrarianApiKey`, and Obsidian's `setSecret` only accepts
 * `/^[a-z0-9-]+$/` up to 64 characters — so it threw "Secret ID is invalid"
 * and the key was never stored. The fake store below enforces Obsidian's rule
 * for the same reason, so a regression cannot pass unnoticed again.
 */
import assert from 'node:assert/strict';
import {
  API_KEY_SECRET,
  LEGACY_API_KEY_SECRETS,
  clearApiKeys,
  isValidSecretId,
  readApiKey,
  writeApiKey,
  type SecretStore,
} from '../src/secrets';

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

const checkAsync = async (desc: string, run: () => Promise<unknown>, expected: unknown): Promise<void> => {
  try {
    assert.deepStrictEqual(await run(), expected);
    console.log(`  ok   ${desc}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${desc}\n       ${e instanceof Error ? e.message : String(e)}`);
  }
};

const checkRejects = async (desc: string, run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
    failed += 1;
    console.error(`  FAIL ${desc} (it did not throw)`);
  } catch {
    console.log(`  ok   ${desc}`);
  }
};

/** An in-memory store that rejects ids exactly like Obsidian does. */
const store = (initial: Record<string, string> = {}): SecretStore & { entries: Map<string, string> } => {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    async set(id, secret) {
      if (!isValidSecretId(id)) {
        throw new Error(
          'El ID del secreto no es válido. Use solo letras minúsculas, números y guiones. Máximo 64 caracteres.',
        );
      }
      entries.set(id, secret);
    },
    async get(id) {
      return entries.get(id) ?? null;
    },
    async remove(id) {
      return void entries.delete(id);
    },
  };
};

// --- the rule Obsidian enforces -------------------------------------------------
check('the id has no uppercase letters', API_KEY_SECRET === API_KEY_SECRET.toLowerCase(), true);
check('the id is valid for Obsidian', isValidSecretId(API_KEY_SECRET), true);
check('lowercase, digits and dashes are accepted', isValidSecretId('wiki-forge-api-key'), true);
check('a 64-character id is accepted', isValidSecretId('a'.repeat(64)), true);
check('a 65-character id is not', isValidSecretId('a'.repeat(65)), false);
check('uppercase is rejected', isValidSecretId('wikiForgeApiKey'), false);
check('underscores are rejected', isValidSecretId('wiki_forge'), false);
check('spaces are rejected', isValidSecretId('wiki forge'), false);
check('an empty id is rejected', isValidSecretId(''), false);

// The whole reason for the migration: the old ids are the invalid ones.
check('there is exactly one legacy id', LEGACY_API_KEY_SECRETS, ['vaultLibrarianApiKey']);
check('the legacy id is rejected by Obsidian', isValidSecretId(LEGACY_API_KEY_SECRETS[0]), false);
check('the legacy id is not the current one', LEGACY_API_KEY_SECRETS.includes(API_KEY_SECRET), false);

// --- writing --------------------------------------------------------------------
const empty = store();
checkAsync(
  'a key is written under the current id',
  async () => {
    await writeApiKey(empty, '  gsk_test_123  ');
    return empty.entries.get(API_KEY_SECRET);
  },
  'gsk_test_123',
);
checkRejects('an empty key is refused', () => writeApiKey(store(), '   '));

// --- reading --------------------------------------------------------------------
checkAsync('a stored key is returned', () => readApiKey(store({ [API_KEY_SECRET]: 'gsk_new' })), 'gsk_new');
checkAsync('an absent key is null', () => readApiKey(store()), null);
checkAsync('an emptied key counts as absent', () => readApiKey(store({ [API_KEY_SECRET]: '' })), null);

checkAsync(
  'a key left under the legacy id is found',
  () => readApiKey(store({ vaultLibrarianApiKey: 'gsk_old' })),
  'gsk_old',
);
checkAsync(
  'and it is moved to the current id',
  async () => {
    const s = store({ vaultLibrarianApiKey: 'gsk_old' });
    await readApiKey(s);
    return [s.entries.get(API_KEY_SECRET), s.entries.has('vaultLibrarianApiKey')];
  },
  ['gsk_old', false],
);
checkAsync(
  'the current id wins over the legacy one',
  () => readApiKey(store({ [API_KEY_SECRET]: 'gsk_new', vaultLibrarianApiKey: 'gsk_old' })),
  'gsk_new',
);

// --- clearing -------------------------------------------------------------------
checkAsync(
  'clearing removes the current and the legacy id',
  async () => {
    const s = store({ [API_KEY_SECRET]: 'gsk_new', vaultLibrarianApiKey: 'gsk_old' });
    await clearApiKeys(s);
    return s.entries.size;
  },
  0,
);
checkAsync(
  'clearing does not resurrect a legacy key',
  async () => {
    const s = store({ vaultLibrarianApiKey: 'gsk_old' });
    await clearApiKeys(s);
    return readApiKey(s);
  },
  null,
);

console.log(failed === 0 ? 'secrets: all checks passed' : `secrets: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
