/**
 * Where a note lives.
 *
 * The model is never asked "where does this note belong?" in the abstract: it is
 * asked to copy one line out of a list of folders that exist in the vault, and
 * an answer that is not on that list is shown as such instead of applied. Same
 * discipline as the tags, and for the same reason — a model judges well and
 * remembers exact paths badly, and here the vault's own folder names carry
 * prefixes, accents and Tifinagh script that no model will reproduce by choice.
 *
 * Pure module: no Obsidian, no network, so all of it is unit-tested. The move
 * itself (which is what rewrites links) lives in `apply.ts`.
 */

/**
 * A vault folder path with the noise models wrap around paths removed.
 *
 * Models answer with `` `…` ``, quotes, `[brackets]`, a trailing slash, or
 * backslashes from a Windows habit. None of that is part of the path, and any of
 * it left in place makes a correct answer fail the match — which would be a
 * silent no-op in a feature whose whole point is to be applied.
 */
export function normalizeFolderPath(value: string): string {
  let path = value.trim();
  path = path.replace(/^[`"'\[\]]+/, '').replace(/[`"'\[\]]+$/, '').trim();
  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
  path = path.replace(/\/+$/, '');
  // The root of the vault is written in more than one way, and none of them is a
  // folder you can be moved to: the root is where notes already are.
  if (path === '.' || path === '/' || path === '(root)') return '';
  return path;
}

/**
 * Comparison key: case and Unicode-composition aside, nothing else.
 *
 * Deliberately *not* `normalizeForMatch` from `similarity`, which keeps only
 * `[a-z0-9]`: it would collapse two different Tifinagh folder names to the same
 * empty string and match the wrong one. Folders are compared whole, and
 * near-misses are refused rather than guessed.
 */
function folderKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/**
 * The folder from `targets` that the model named, or null when it named none of
 * them. Null means "no move", never "move somewhere close": a folder the vault
 * does not have is not a destination.
 */
export function matchFolder(targets: string[], suggestion: string): string | null {
  const wanted = normalizeFolderPath(suggestion);
  if (!wanted) return null;
  const key = folderKey(wanted);
  return targets.find(target => folderKey(target) === key) ?? null;
}

/**
 * Whether a folder is a legitimate destination.
 *
 * Hidden folders (`.obsidian`, `.trash`, `.smart-env`…) are out, any segment
 * named in `excludedFolders` is out — the same list the scan uses, so a folder
 * the plugin refuses to read is not offered as a place to write — and so is the
 * plugin's own data folder, which holds `proposals.json` and the backups.
 */
export function isCandidateFolder(path: string, excluded: string[], avoid: string[] = []): boolean {
  const folder = normalizeFolderPath(path);
  if (!folder) return false;
  const segments = folder.split('/');
  if (segments.some(segment => segment.startsWith('.'))) return false;
  // Two ways to name an exclusion, matching how the setting is written: a bare
  // name skips any folder with that segment (`node_modules`), and a name with a
  // slash skips that exact path and its subtree (`80-support/templates`).
  const isExcluded = (entry: string): boolean => {
    if (entry === '') return false;
    if (!entry.includes('/')) return segments.includes(entry);
    const prefix = normalizeFolderPath(entry);
    return folder === prefix || folder.startsWith(`${prefix}/`);
  };
  if (excluded.some(isExcluded)) return false;
  return !avoid.some(isExcluded);
}

/**
 * Whether a path — a folder or a note — sits inside one of these roots.
 *
 * The roots are written as folder paths (`00-src`), and a note counts as inside
 * when the root *is* its folder or an ancestor of it. Kept exact on purpose: a
 * root of `00-src/30-dev` does not cover `00-src/30-dev-otros`, which is the
 * mistake a `startsWith` without the separator makes.
 */
export function isInsideRoots(path: string, roots: string[]): boolean {
  const target = normalizeFolderPath(path);
  if (!target) return false;
  return roots.some(root => {
    const ask = normalizeFolderPath(root);
    return ask !== '' && (target === ask || target.startsWith(`${ask}/`));
  });
}

/**
 * The roots the move destinations come from.
 *
 * Two lists, because they answer two different questions: where your notes live
 * (which notes are worth asking about a folder) and where a note may go. An
 * inbox is the case that separates them — it is full of your notes, and it is
 * where things are *picked up from*, not filed into.
 *
 * The destinations fall back to the notes folders when they are not set, and an
 * empty result at the end means "no restriction at all": an existing vault that
 * never fills these in keeps working exactly as it did.
 */
export function effectiveRoots(noteFolders: string[], moveFolders: string[]): string[] {
  return moveFolders.length > 0 ? moveFolders : noteFolders;
}

export interface PlannedMove {
  /** Folder the note is in today. Empty when it sits at the vault root. */
  from: string;
  /** Full path the note would have. */
  to: string;
}

/**
 * The move a suggestion means, or null when there is nothing to do.
 *
 * The note keeps its file name — this feature is about the folder, and renaming
 * is a different decision (it breaks every link that spells the old title).
 * A suggestion equal to the note's current folder is not an error and not a
 * move: it is the model saying "it is where it belongs", which is why the plugin
 * asks for the folder rather than for a change.
 */
export function planMove(notePath: string, target: string): PlannedMove | null {
  const folder = normalizeFolderPath(target);
  if (!folder) return null;
  const file = notePath.split('/').pop() ?? '';
  if (!file || !/\.md$/i.test(file)) return null;
  const from = notePath.split('/').slice(0, -1).join('/');
  if (folderKey(from) === folderKey(folder)) return null;
  return { from, to: `${folder}/${file}` };
}

/**
 * The folder name out of the model's answer, whatever shape it came in.
 *
 * A model that has to answer with a path sometimes answers with a one-element
 * list or with the path in brackets; neither is a wrong answer, just a badly
 * formatted one, and the cleaner above is what decides that.
 */
export function folderAnswer(value: unknown): string {
  if (typeof value === 'string') return normalizeFolderPath(value);
  if (Array.isArray(value)) {
    const first = value.find(item => typeof item === 'string');
    return typeof first === 'string' ? normalizeFolderPath(first) : '';
  }
  return '';
}

export interface FolderDecision {
  /** Folder to move the note to; `''` when it stays where it is. */
  moveTo: string;
  /** Folder the model named that the vault does not have; `''` when none. */
  unknownFolder: string;
}

/**
 * Turns the model's answer into the two fields the proposal stores.
 *
 * Three outcomes, and the middle one is the reason this is not a one-liner: an
 * answer naming a folder the vault does not have is kept as `unknownFolder` so
 * the review panel can show it, instead of being dropped as if the model had
 * said nothing. A folder that matches but is the note's current one lands in
 * neither field — that is not a failure, it is the model saying "leave it".
 */
export function resolveFolderAnswer(
  notePath: string,
  targets: string[],
  answer: unknown,
): FolderDecision {
  const wanted = folderAnswer(answer);
  if (!wanted) return { moveTo: '', unknownFolder: '' };
  const matched = matchFolder(targets, wanted);
  if (!matched) return { moveTo: '', unknownFolder: wanted };
  return { moveTo: planMove(notePath, matched) ? matched : '', unknownFolder: '' };
}

/** How a move reads in the review panel and in a Notice. */
export function describeMove(notePath: string, target: string): string {
  const move = planMove(notePath, target);
  if (!move) return 'already in that folder';
  return `${move.from || '(root)'} → ${move.to}`;
}

/** Prompt line 4: the folder, copied verbatim from the list, or "". */
export const MOVE_TASK_LINE =
  `4. "folder": the folder this note belongs in, copied character by character from the FOLDERS list. "" when the note is already where it belongs, or when nothing in that list is clearly better.`;

/** Prompt line 5: why, and only when there is a move. */
export const MOVE_REASON_TASK_LINE =
  `5. "folder_reason": one short sentence in the note's own language saying why, only when 4 is not "".`;

/**
 * The rules that keep folder suggestions from becoming a reshuffle.
 *
 * The middle one is the important one: without it a model will "tidy" a folder
 * name by moving notes around, and every move rewrites links in other notes. A
 * wrong tag is a word in a frontmatter; a wrong move touches the vault.
 */
export const MOVE_RULES = [
  `- "folder" must come from the FOLDERS list below. A folder that is not in that list does not exist, so it is never the answer: use "" instead of inventing one or writing something similar.`,
  `- The folder the note is in is already an option, and it is the right answer far more often than not. Suggest a move only when the note plainly belongs somewhere else, never to rename or tidy a folder.`,
  `- Prefixes and numbers are part of the folder name ("60-plasma 6" is not "plasma"): copy them.`,
];

/** Highest number of folders spelled out in the prompt, to keep it bounded. */
export const MAX_FOLDERS_IN_PROMPT = 200;

/**
 * The folder list handed to the model.
 *
 * The list *is* the answer space, so it is spelled out in full rather than
 * summarised: the model cannot copy a path it has not been shown, and a
 * summarised folder ("the plasma one") is exactly the near-miss this module
 * refuses.
 */
export function folderListBlock(folders: string[]): string {
  const shown = folders.slice(0, MAX_FOLDERS_IN_PROMPT);
  const lines = ['FOLDERS (the only valid answers for "folder"):'];
  lines.push(...shown.map(folder => `- ${folder}`));
  if (folders.length > shown.length) {
    lines.push(`…and ${folders.length - shown.length} more folder(s), not listed here.`);
  }
  return lines.join('\n');
}
