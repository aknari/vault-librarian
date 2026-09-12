/**
 * Where the API key lives, and the rules Obsidian imposes on that name.
 *
 * `app.secretStorage` is shared by every plugin (it is the same keychain the
 * "Secret storage" section of Obsidian's settings edits), and Obsidian only
 * accepts ids that match `/^[a-z0-9-]+$/` with at most 64 characters. Anything
 * else makes `setSecret` throw *"Secret ID is invalid. Use only lowercase
 * letters, numbers and dashes. 64 characters max."*.
 *
 * The first version of this plugin asked for `vaultLibrarianApiKey`, which
 * fails that rule, so the key could never be written at all. The camel-case
 * names are kept here only to *read* a key stored by a version of Obsidian that
 * did not enforce the rule; `readApiKey` moves it to the current id.
 */
export const API_KEY_SECRET = 'vault-librarian-api-key';

/** Ids used before the rule was noticed: read-only, migrated on first read. */
export const LEGACY_API_KEY_SECRETS = ['vaultLibrarianApiKey'];

/** Obsidian's own rule, mirrored from `SecretStorage.validateId`. */
export const isValidSecretId = (id: string): boolean => /^[a-z0-9-]+$/.test(id) && id.length <= 64;

/**
 * The slice of Obsidian's secret storage this plugin needs. `remove` is
 * optional because only modern Obsidian has `deleteSecret`; without it an
 * emptied secret is written as an empty string, which reads back as absent.
 */
export interface SecretStore {
  set(id: string, secret: string): Promise<void>;
  get(id: string): Promise<string | null>;
  remove?: (id: string) => Promise<void>;
}

const present = (value: string | null): value is string => value !== null && value !== '';

/**
 * Reads the API key, falling back to a key saved under a legacy id and moving
 * it to the current one. The move is best effort: if it fails, the old key is
 * still returned and still works, so nothing is lost.
 */
export async function readApiKey(store: SecretStore): Promise<string | null> {
  const current = await store.get(API_KEY_SECRET);
  if (present(current)) return current;

  for (const legacy of LEGACY_API_KEY_SECRETS) {
    const old = await store.get(legacy);
    if (!present(old)) continue;
    try {
      await store.set(API_KEY_SECRET, old);
      await clear(store, legacy);
    } catch {
      // Ignored on purpose: the key is usable where it is.
    }
    return old;
  }
  return null;
}

/**
 * Writes the key under the current id. The id is checked here as well so that a
 * mistake in the constant above fails with a message that points at the cause,
 * instead of Obsidian's generic "Secret ID is invalid".
 */
export async function writeApiKey(store: SecretStore, value: string): Promise<void> {
  const key = value.trim();
  if (key === '') throw new Error('the API key is empty.');
  if (!isValidSecretId(API_KEY_SECRET)) {
    throw new Error(
      `internal error: "${API_KEY_SECRET}" is not a valid Obsidian secret id (lowercase letters, numbers and dashes only).`,
    );
  }
  await store.set(API_KEY_SECRET, key);
}

/** Clears the key everywhere it can be: the current id and every legacy one. */
export async function clearApiKeys(store: SecretStore): Promise<void> {
  for (const id of [API_KEY_SECRET, ...LEGACY_API_KEY_SECRETS]) {
    try {
      await clear(store, id);
    } catch {
      // Ignored on purpose: clearing is best effort.
    }
  }
}

const clear = async (store: SecretStore, id: string): Promise<void> => {
  if (store.remove) await store.remove(id);
  else await store.set(id, '');
};
