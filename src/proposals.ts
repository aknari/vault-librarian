/**
 * The proposal queue: what the model suggested, plus the rule that decides which
 * notes a run may visit.
 *
 * Pure module — no Obsidian, no network — so that rule stays testable. It is the
 * one piece of the plugin that can silently strand notes: a pending proposal is
 * only revisited when its note changes, so a run that produced nothing usable
 * used to freeze those notes for good.
 */
import type { CatalogEntry } from './analysis';
import { normalizeForMatch } from './similarity';

/**
 * How many tags the prompt asks for.
 *
 * There is deliberately no floor above one. A minimum of three was the largest
 * single source of wrong tags: a short note (a book reference, a list of links)
 * cannot justify three tags, so the model padded the list with whatever was
 * nearest. Two different models produced the same invented tag (`tema/obsidian`
 * on a note that never mentions Obsidian) purely to reach that quota. A short
 * list is the honest answer, and the prompt now says so.
 */
export const TAG_LIMITS = { min: 1, max: 6 } as const;

/** The prompt line that states the tag count, built from the limits above. */
export const TAG_TASK_LINE =
  `2. "tags": ${TAG_LIMITS.min} to ${TAG_LIMITS.max} tags, each one supported by the note itself.`;

/**
 * The rule that keeps the model from padding.
 *
 * Kept next to the limits so the two cannot drift apart: a quota without this
 * rule invites invented tags, and this rule without a free count cannot be
 * obeyed.
 */
export const TAG_SUPPORT_RULES = [
  `- Every tag must be supported by what the note itself says. If you cannot point`,
  `  to the place where it says it, leave that tag out.`,
  `- A short list is the right answer for a short note. Never pad the list to reach`,
  `  a number, and never pick a value only because it is the closest or the most`,
  `  generic one available: one right tag beats three plausible ones.`,
];

/**
 * The prompt that asks the model to group the vault's own tags into facets.
 *
 * No language is named anywhere in it. The listing below *is* the user's
 * language, so the answer has to keep it: naming one (this used to read
 * "Spanish here if they are Spanish", and the facet examples were Spanish too)
 * steers every other user's facet names to that language — and facet names end
 * up written inside the notes as `facet/value`. For the same reason the JSON
 * shape is described with types instead of a filled-in example: an example is
 * content, and content gets copied.
 */
export function vocabularySuggestionPrompt(
  tags: Array<{ tag: string; count: number }>,
  promptVersion: string,
  maxTags = 400,
): string {
  const listing = tags.slice(0, maxTags).map(t => `${t.tag} (${t.count})`).join('\n');
  return [
    `PROMPT_VERSION: ${promptVersion}`,
    `These are all the tags currently used in a personal Obsidian vault, with how many notes use each one.`,
    `Group them into at most 8 facets. A facet gathers values of the same kind: what a note is about, what kind of note it is, where it belongs, or its state.`,
    `Rules:`,
    `- Name every facet in the language the tags below are written in, and keep each value exactly as it appears in the list.`,
    `- Never translate a tag, and never name a facet in a different language: that listing is the user's own.`,
    `- Use short lowercase names, no accents and no slashes.`,
    `- Merge obvious synonyms and near-duplicates into a single value.`,
    `- Do not invent tags that are not in the list.`,
    `- Answer with ONLY a JSON object of this shape: {"facets": [{"name": string, "values": string[]}]}`,
    ``,
    `TAGS:`,
    listing,
  ].join('\n');
}

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
  /**
   * Folder this note belongs in, `''` when it stays where it is.
   *
   * Only a folder that exists in the vault survives validation, so a value here
   * is always a path the plugin can actually move the note to — the move itself
   * is the one action here that touches more than one file, because Obsidian
   * rewrites every link pointing at the note.
   */
  moveTo: string;
  /** Why, in the note's own language. `''` when there is no move. */
  moveReason: string;
  /**
   * Folder the model named that the vault does not have, `''` when it named
   * none. Kept visible for the same reason unknown tags are: dropping it
   * silently hides the one thing worth knowing.
   */
  unknownFolder: string;
  status: ProposalStatus;
  /**
   * The note changed after this proposal was written, so it may be out of date.
   *
   * Set by a run, never by the model. It is a *flag and not an action* on
   * purpose: the usual reason a note changes by itself is a plugin rewriting
   * its frontmatter (a timestamp updater does it on every open), and silently
   * re-asking would discard whatever the user had edited in the review panel.
   */
  noteChanged?: boolean;
}

export interface ProposalsFile {
  model: string;
  /** Prompt that produced these proposals; drives the `stale` flag below. */
  promptVersion: string;
  /**
   * Whether folder suggestions were asked for when this file was written. Part
   * of the cache key, like the prompt and the model: turning the option on has
   * to re-ask, or the queue would say "nothing to move" for ever.
   */
  moveEnabled: boolean;
  updatedAt: string;
  proposals: Proposal[];
}

/**
 * Drops the note's own title from its "related" list.
 *
 * The model is handed every title in the vault, its own included, and it does
 * return its own: a note related to itself is provably wrong, so it is filtered
 * here instead of trusted. The list is also capped at the five the prompt asks
 * for, because nothing enforced that either.
 */
export function withoutSelf(related: string[], ownTitle: string): string[] {
  const own = normalizeForMatch(ownTitle);
  return related.filter(title => normalizeForMatch(title) !== own).slice(0, 5);
}

/**
 * Whether a note belongs in the next run.
 *
 * A decision already taken (accepted, applied, rejected) is never revisited. A
 * pending proposal is renewed when the prompt or the model changed (`stale`),
 * because then it holds the answer to a question nobody is asking any more.
 *
 * A pending proposal whose *note changed* is deliberately **not** renewed. The
 * note changes by itself more often than you would think — a timestamp plugin
 * rewrites its frontmatter on every open — and re-asking then replaces the
 * pending proposal with a fresh one, throwing away any hand edit made in the
 * review panel. So the run only flags it (`isNoteChanged`) and `Re-propose this
 * note` is how it gets renewed, which is a decision the user takes.
 */
export function shouldPropose(
  existing: Proposal | undefined,
  stale: boolean,
  force = false,
  allowDecided = false,
): boolean {
  if (!existing) return true;
  // `force` is the user asking about one note on purpose ("Re-propose this
  // note"), and it is the only way to get a second opinion without touching the
  // note: editing it would move its mtime, which is the very signal the cache
  // reads. It still refuses the two statuses that hold work already done —
  // `accepted` (reviewed but not applied yet) and `applied` (already written
  // into the note) — because replacing those would throw that work away. A
  // `rejected` note *is* revisitable here on purpose: without that, one click
  // would take the note out of the system for good.
  //
  // `allowDecided` is the user overriding that refusal on purpose, from the
  // picker. It exists because refusing with no way through left the note
  // unreachable: the picker would not offer it and no command could ask again.
  // It only ever applies to a hand-picked run, never to a batch.
  if (force) {
    return (
      existing.status === 'pending' ||
      existing.status === 'rejected' ||
      (allowDecided && (existing.status === 'accepted' || existing.status === 'applied'))
    );
  }
  // Only a *pending* suggestion is up for renewal. Anything else is a decision
  // the user already took, and a new run must not quietly overwrite it: an
  // accepted-but-not-yet-applied proposal would lose the review work.
  if (existing.status !== 'pending') return false;
  return stale;
}

/**
 * True when a pending proposal no longer matches the note it describes, so the
 * review panel can say so and offer to re-ask. Never true for a decided one:
 * there the tags are already accepted or written, and the note's mtime moved
 * because of that very apply.
 */
export function isNoteChanged(existing: Proposal, entry: CatalogEntry): boolean {
  return existing.status === 'pending' && existing.mtime !== entry.mtime;
}

export type PickerState =
  | 'new'
  | 'pending'
  | 'out-of-date'
  | 'rejected'
  | 'accepted'
  | 'applied';

export interface PickerRow {
  state: PickerState;
  /** Whether a run can be asked about this note from the picker. */
  selectable: boolean;
  /** Why not, or what selecting it will do. */
  note: string;
}

/**
 * What the note picker shows for one note.
 *
 * `selectable` mirrors `shouldPropose(..., force: true)` on purpose, so a tick
 * can never turn into a silent no-op: only the statuses a forced run accepts are
 * offered. `accepted` and `applied` hold work already done — a review not yet
 * applied, or tags already written into the note — so they are refused here, and
 * with the reason, because a checkbox that does nothing is worse than no
 * checkbox at all.
 */
export function pickerRow(
  existing: Proposal | undefined,
  noteChanged: boolean,
  allowDecided = false,
): PickerRow {
  if (!existing) return { state: 'new', selectable: true, note: 'no proposal yet' };
  switch (existing.status) {
    case 'pending':
      return noteChanged
        ? { state: 'out-of-date', selectable: true, note: 'pending, the note changed' }
        : { state: 'pending', selectable: true, note: 'pending review' };
    case 'rejected':
      return { state: 'rejected', selectable: true, note: 'rejected, ask again' };
    case 'accepted':
      return {
        state: 'accepted',
        selectable: allowDecided,
        note: allowDecided ? 'asked again, its proposal is replaced' : 'accepted, not applied',
      };
    default:
      return {
        state: 'applied',
        selectable: allowDecided,
        note: allowDecided ? 'asked again, its proposal is replaced' : 'already applied',
      };
  }
}

/**
 * Short name for each state, drawn as a chip next to the note in the picker.
 *
 * The `note` above says the same thing in a sentence, and it was there from the
 * start — but it was rendered with the same styling as every other piece of
 * text, so a row that could be ticked and a row that could not looked identical
 * until you clicked. `Record<PickerState, string>` and not an optional field, so
 * that adding a state fails the build until it is named here.
 */
export const PICKER_STATE_LABEL: Record<PickerState, string> = {
  new: 'new',
  pending: 'pending',
  'out-of-date': 'out of date',
  rejected: 'rejected',
  accepted: 'accepted',
  applied: 'applied',
};
