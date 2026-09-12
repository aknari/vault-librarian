import { App } from 'obsidian';
import type { LibrarianSettings } from './settings';
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

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'applied';

export interface Proposal {
  path: string;
  /** Note mtime when the proposal was generated (cache key). */
  mtime: number;
  summary: string;
  tags: string[];
  related: string[];
  /** Tags suggested by the model that the vocabulary does not know. */
  unknown: string[];
  status: ProposalStatus;
}

export interface ProposalsFile {
  model: string;
  promptVersion: string;
  updatedAt: string;
  proposals: Proposal[];
}

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
  const listing = tags.slice(0, 400).map(t => `${t.tag} (${t.count})`).join('\n');
  const prompt = [
    `PROMPT_VERSION: v1`,
    `These are all the tags currently used in a personal Obsidian vault, with how many notes use each one.`,
    `Group them into at most 8 facets (for example: proyecto, tipo, estado, materia, tema).`,
    `Rules:`,
    `- Use short lowercase names, no accents and no slashes.`,
    `- Merge obvious synonyms and near-duplicates into a single value.`,
    `- Prefer the language of the tags (Spanish here if they are Spanish).`,
    `- Do not invent tags that are not in the list.`,
    `- Answer with ONLY JSON: {"facets":[{"name":"proyecto","values":["lisa","amawal"]}]}`,
    ``,
    `TAGS:`,
    listing,
  ].join('\n');

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

/** The versioned prompt. Bump settings.promptVersion when this changes. */
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
    `PROMPT_VERSION: v1`,
    `You are cataloguing a personal Obsidian vault. Work on ONE note.`,
    ``,
    `VOCABULARY (use ONLY these tags, exact form facet/value):`,
    vocabularyPrompt(vocabulary),
    ``,
    `TASKS`,
    `1. "summary": one sentence in the note's own language (max 140 characters).`,
    `2. "tags": between 3 and 6 tags chosen only from the vocabulary above.`,
    `3. "related": up to 5 titles of existing notes clearly related to this one (titles only, no brackets). Empty list if none.`,
    ``,
    `RULES`,
    `- Never invent a tag outside the vocabulary; if nothing fits, return fewer tags.`,
    `- Do not repeat the note's title as a tag value.`,
    `- Answer with ONLY a JSON object, no prose and no code fences.`,
    `- Shape: {"summary": "...", "tags": ["..."], "related": ["..."]}`,
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
  onProgress?: (done: number, total: number, label: string) => void,
  isCancelled?: () => boolean,
): Promise<{ file: ProposalsFile; summary: ProposeSummary }> {
  const file = await loadProposals(app, settings);
  file.model = settings.model;
  const byPath = new Map(file.proposals.map(p => [p.path, p]));
  const vaultTitles = entries.map(e => e.title);

  const todo = entries.filter(entry => {
    const existing = byPath.get(entry.path);
    if (!existing) return true;
    if (existing.status === 'rejected' || existing.status === 'applied') return false;
    return existing.mtime !== entry.mtime; // re-propose only when the note changed
  });

  const total = Math.min(todo.length, Math.max(1, settings.maxNotesPerRun));
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
        related: parsed.related,
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
    },
  };
}
