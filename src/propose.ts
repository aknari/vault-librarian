import { App } from 'obsidian';
import { DEFAULT_SETTINGS, type LibrarianSettings } from './settings';
import type { CatalogEntry } from './analysis';
import {
  normalizeTag,
  parseVocabulary,
  validateTags,
  vocabularyPrompt,
  type Vocabulary,
} from './vocabulary';
import { askLlm } from './llm';
import { readText, writeFileSafe } from './vault-io';
import {
  TAG_SUPPORT_RULES,
  TAG_TASK_LINE,
  isNoteChanged,
  shouldPropose,
  vocabularySuggestionPrompt,
  withoutSelf,
  type Proposal,
  type ProposalsFile,
} from './proposals';

// The queue's shape and the rule that decides which note a run visits live in a
// pure module; re-exported here so every existing importer keeps working.
export type { Proposal, ProposalStatus, ProposalsFile } from './proposals';

export const PROPOSALS_FILE = 'proposals.json';

export function emptyProposalsFile(settings: LibrarianSettings): ProposalsFile {
  return {
    model: settings.model,
    promptVersion: settings.promptVersion,
    updatedAt: new Date().toISOString(),
    proposals: [],
  };
}

export async function loadProposals(
  app: App,
  settings: LibrarianSettings,
): Promise<ProposalsFile> {
  const text = await readText(app, `${settings.dataFolder}/${PROPOSALS_FILE}`);
  if (text) {
    try {
      const parsed = JSON.parse(text) as ProposalsFile;
      if (Array.isArray(parsed?.proposals)) {
        return {
          model: String(parsed.model ?? settings.model),
          promptVersion: String(parsed.promptVersion ?? settings.promptVersion),
          updatedAt: String(parsed.updatedAt ?? new Date().toISOString()),
          proposals: parsed.proposals,
        };
      }
    } catch {
      // corrupted file — start over rather than fail the command
    }
  }
  return emptyProposalsFile(settings);
}

export async function saveProposals(
  app: App,
  settings: LibrarianSettings,
  file: ProposalsFile,
): Promise<void> {
  file.updatedAt = new Date().toISOString();
  await writeFileSafe(app, `${settings.dataFolder}/${PROPOSALS_FILE}`, JSON.stringify(file, null, 2));
}

/**
 * Asks the model to group the tags already present in the vault into facets.
 * The result is a draft: it lands in the vocabulary editor for the user to edit.
 */
export async function suggestVocabulary(
  settings: LibrarianSettings,
  apiKey: string,
  tags: Array<{ tag: string; count: number }>,
): Promise<Vocabulary> {
  const prompt = vocabularySuggestionPrompt(tags, DEFAULT_SETTINGS.promptVersion);

  const answer = await askLlm(settings, apiKey, prompt, 'vocabulary');
  const cleaned = answer.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('the model did not return a JSON vocabulary.');
  }
  try {
    return parseVocabulary(JSON.parse(cleaned.slice(start, end + 1)));
  } catch {
    throw new Error('the model returned malformed JSON for the vocabulary.');
  }
}

export interface ProposalResult {
  summary: string;
  tags: string[];
  related: string[];
}

/**
 * The versioned prompt. Bump settings.promptVersion when this changes.
 *
 * The examples in the rules show the *shape* with stand-ins (`faceta/valor`),
 * never a real tag. A weak model copies the example, and a real tag copied by
 * mistake is valid — so it passes validation and gets written to the note. A
 * stand-in that gets copied fails the vocabulary lookup instead and is shown in
 * red, which is the safe way to be wrong.
 */
export function proposalPrompt(
  entry: CatalogEntry,
  vocabulary: Vocabulary,
  noteText: string,
  vaultTitles: string[],
  maxChars: number,
): string {
  const body = maxChars > 0 && noteText.length > maxChars ? `${noteText.slice(0, maxChars)}\n…[truncated]` : noteText;
  const titles = vaultTitles.slice(0, 600).join(' | ');
  return [
    `PROMPT_VERSION: ${DEFAULT_SETTINGS.promptVersion}`,
    // "Obsidian" used to be here, and it was a leak: the word appeared in the
    // instructions *and* `tema/obsidian` sat in the vocabulary, so two different
    // models tagged unclassifiable notes (a list of streaming links, a note
    // written entirely in Tifinagh) with it. An instruction is content too.
    `You are cataloguing a personal markdown vault. Work on ONE note.`,
    ``,
    `VOCABULARY (use ONLY these tags, exact form facet/value):`,
    vocabularyPrompt(vocabulary),
    ``,
    `TASKS`,
    `1. "summary": one sentence in the note's own language (max 140 characters).`,
    TAG_TASK_LINE,
    `3. "related": up to 5 titles of existing notes clearly related to this one (titles only, no brackets). Empty list if none.`,
    ``,
    `RULES`,
    `- Never invent a tag outside the vocabulary; if nothing fits, return fewer tags.`,
    ...TAG_SUPPORT_RULES,
    `- Do not repeat the note's title as a tag value.`,
    `- The separator is a slash: "faceta/valor", never "faceta: valor" nor a list bullet.`,
    `- Text in parentheses after a tag describes what that tag means. It is never`,
    `  part of the tag: pick the tag, leave the description out.`,
    `- Answer with ONLY a JSON object, no prose and no code fences.`,
    `- Shape: {"summary": "...", "tags": ["faceta/valor", "otra-faceta/valor"], "related": ["titulo"]}`,
    ``,
    `VAULT TITLES (for "related"):`,
    titles,
    ``,
    `NOTE (${entry.path}):`,
    body,
  ].join('\n');
}

/** Parses the model answer defensively. Returns null when unusable. */
export function parseProposalResponse(text: string): ProposalResult | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const toList = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
      return [];
    };
    return {
      summary,
      tags: toList(parsed.tags).map(normalizeTag).filter(Boolean),
      related: toList(parsed.related).map(r => r.replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean),
    };
  } catch {
    return null;
  }
}

export interface ProposeSummary {
  processed: number;
  skipped: number;
  failed: number;
  pending: number;
  /** Pending proposals the run marked as out of date instead of replacing. */
  flagged: number;
}

export interface ProposeOptions {
  /**
   * Re-ask only these notes, ignoring the up-to-date check ("Re-propose this
   * note"). Empty or absent is the normal run, which honours the cache.
   */
  forcePaths?: string[];
  /**
   * Lets a hand-picked run also replace a proposal that is already `accepted`
   * or `applied`. Off by default, and only meaningful together with
   * `forcePaths`: a batch run must never quietly overwrite a decision.
   */
  allowDecided?: boolean;
}

/**
 * Proposes tags for the notes that have no up-to-date proposal.
 * Saves after every note, so an interrupted run resumes exactly where it stopped.
 */
export async function proposeForEntries(
  app: App,
  settings: LibrarianSettings,
  apiKey: string,
  entries: CatalogEntry[],
  vocabulary: Vocabulary,
  options: ProposeOptions = {},
  onProgress?: (done: number, total: number, label: string) => void,
  isCancelled?: () => boolean,
): Promise<{ file: ProposalsFile; summary: ProposeSummary }> {
  const file = await loadProposals(app, settings);
  // The file records the prompt version and the model that produced it. When
  // either changes, the cached proposals answer a question nobody is asking any
  // more, so they are re-generated instead of blocking those notes for ever:
  // a pending proposal is only ever revisited when its note changes.
  const stale =
    file.promptVersion !== settings.promptVersion || file.model !== settings.model;
  file.model = settings.model;
  const byPath = new Map(file.proposals.map(p => [p.path, p]));
  const vaultTitles = entries.map(e => e.title);

  // Mark — never silently re-ask — the pending proposals whose note changed.
  // The flag is what the review panel reads; re-asking here would replace the
  // proposal and lose any edit made in that panel. Cheap to run every time, and
  // it is the only thing that keeps the flag honest (a note that was edited
  // again goes back to normal once it is re-proposed).
  let flagged = 0;
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (!existing) continue;
    const changed = isNoteChanged(existing, entry);
    if (changed === Boolean(existing.noteChanged)) continue;
    existing.noteChanged = changed;
    flagged++;
  }
  if (flagged > 0) await saveProposals(app, settings, file);

  const forced = new Set(options.forcePaths ?? []);
  const todo = entries.filter(entry => {
    if (forced.size > 0 && !forced.has(entry.path)) return false;
    return shouldPropose(
      byPath.get(entry.path),
      stale,
      forced.has(entry.path),
      options.allowDecided ?? false,
    );
  });

  // A hand-picked selection is the whole batch: the cap is for the "leave it
  // running" case, and honouring it here would silently drop notes the user
  // ticked one by one.
  const cap = forced.size > 0 ? todo.length : Math.max(1, settings.maxNotesPerRun);
  const total = Math.min(todo.length, cap);
  let processed = 0;
  let skipped = todo.length - total;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    if (isCancelled && isCancelled()) break;
    const entry = todo[i];
    if (onProgress) onProgress(i + 1, total, entry.path);
    const noteText = await readText(app, entry.path);
    if (noteText === null) {
      failed++;
      continue;
    }
    try {
      const answer = await askLlm(
        settings,
        apiKey,
        proposalPrompt(entry, vocabulary, noteText, vaultTitles, settings.maxContextChars),
        'proposal',
      );
      const parsed = parseProposalResponse(answer);
      if (!parsed) {
        failed++;
        continue;
      }
      const { valid, unknown } = validateTags(vocabulary, parsed.tags);
      const proposal: Proposal = {
        path: entry.path,
        mtime: entry.mtime,
        summary: parsed.summary,
        tags: valid,
        related: withoutSelf(parsed.related, entry.title),
        unknown,
        status: 'pending',
      };
      const idx = file.proposals.findIndex(p => p.path === entry.path);
      if (idx >= 0) file.proposals[idx] = proposal;
      else file.proposals.push(proposal);
      byPath.set(entry.path, proposal);
      processed++;
    } catch (e) {
      console.error('Vault Librarian: proposal failed for', entry.path, e);
      failed++;
    }
    await saveProposals(app, settings, file);
  }

  file.promptVersion = settings.promptVersion;
  await saveProposals(app, settings, file);

  return {
    file,
    summary: {
      processed,
      skipped,
      failed,
      pending: file.proposals.filter(p => p.status === 'pending').length,
      flagged,
    },
  };
}
