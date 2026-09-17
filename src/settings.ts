export type Provider = 'google' | 'openai';
export type TagMode = 'merge' | 'replace';

/**
 * Model list fetched from the provider, cached so the Model dropdown still has
 * its options after a restart. It carries the provider and base URL it was
 * fetched from, so switching either of them invalidates it instead of offering
 * models that belong to another API.
 */
export interface ModelCache {
  provider: Provider;
  baseUrl: string;
  models: string[];
}

export interface LibrarianSettings {
  /** LLM provider: google = Gemini REST; openai = any OpenAI-compatible API. */
  provider: Provider;
  model: string;
  baseUrl: string;
  /** Cached model list for the Model dropdown (`null` until something is fetched). */
  modelCache: ModelCache | null;
  /** UI flag: whether an API key is present in the system keychain. */
  apiKeyConfigured: boolean;

  /** Where the catalogue, vocabulary, proposals and report live. */
  dataFolder: string;
  /** Note that receives the human-readable audit report. */
  reportPath: string;
  /**
   * Name fragments used only to *label* the Model dropdown: a model containing
   * one of them is shown as "free tier". Google does not expose billing tiers
   * through its API, so this is a hint you keep up to date (default: `flash`).
   */
  freeTierPatterns: string[];
  /**
   * Name patterns for models to leave out of the dropdown. Same syntax as
   * `freeTierPatterns` (a line starting with `!` brings a model back), because
   * a guard classifier is text-in/text-out like any chat model and no metadata
   * distinguishes it. The defaults are the families that cannot hold a
   * conversation: Whisper (transcription), Orpheus (speech), embeddings,
   * re-rankers and the prompt-guard/safeguard classifiers.
   */
  hiddenModelPatterns: string[];
  /** Folder names skipped while scanning (matched on any path segment). */
  excludedFolders: string[];
  /** How many notes a single "Propose tags" run may process. */
  maxNotesPerRun: number;
  /** Characters of each note sent to the model (0 = whole note). */
  maxContextChars: number;

  /**
   * Ask the model which folder each note belongs in, so a misplaced note can be
   * moved from the review panel. Off means the prompt never mentions folders.
   */
  moveEnabled: boolean;
  /**
   * Where your own notes live: only notes inside these folders are asked which
   * folder they belong in. Empty = every scanned note is asked.
   */
  noteFolders: string[];
  /**
   * Folders a note may be moved to. Empty = the notes folders above; and if
   * those are empty too, every folder the scan does not exclude.
   */
  moveFolders: string[];

  /** Generate one MOC note per folder with 2+ notes. */
  mocEnabled: boolean;
  /** File name (without .md) used for MOC notes. */
  mocFileName: string;
  /** Tag added to MOC notes. */
  mocTag: string;
  /** merge = keep existing tags and add the accepted ones; replace = set exactly. */
  tagMode: TagMode;
  /**
   * Cache key for `proposals.json`, bumped whenever the prompt changes so the
   * stored proposals are regenerated instead of blocking those notes. It is not
   * a preference: the value in the code always wins at load time.
   */
  promptVersion: string;
}

export const DEFAULT_SETTINGS: Readonly<LibrarianSettings> = Object.freeze({
  // Groq is a sensible default here: fast, OpenAI-compatible and free tier friendly.
  provider: 'openai',
  model: 'qwen/qwen3.8-27b',
  baseUrl: 'https://api.groq.com/openai/v1',
  modelCache: null,
  apiKeyConfigured: false,

  dataFolder: '80-support/librarian',
  reportPath: '80-support/librarian/informe.md',
  excludedFolders: ['.obsidian', '.trash', 'node_modules', '85-archive', '80-support/templates'],
  freeTierPatterns: ['flash', '!tts', '!image'],
  hiddenModelPatterns: ['whisper', 'tts', 'orpheus', 'embed', 'rerank', 'guard'],
  maxNotesPerRun: 25,
  maxContextChars: 4000,

  moveEnabled: true,
  // Empty on purpose, and not a guess at somebody's layout: with no restriction
  // the feature behaves as it did before these settings existed.
  noteFolders: [],
  moveFolders: [],
  mocEnabled: true,
  mocFileName: '_MOC',
  mocTag: 'moc',
  tagMode: 'merge',
  // v5: descriptions per facet and per value; "Obsidian" removed from the
  // framing line; no automatic renewal of a pending proposal whose note changed.
  // v6: the folder suggestion ("folder" / "folder_reason") and the FOLDERS list
  // it has to be copied from.
  promptVersion: 'v6',
});
