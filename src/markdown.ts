/**
 * Pure markdown helpers (no Obsidian imports, so they are unit-testable).
 *
 * The frontmatter parser is deliberately conservative: it understands simple
 * `key: value` lines, inline arrays `[a, b]` and block lists, and passes
 * anything else through untouched as `raw` so no exotic YAML is ever lost.
 */

export type FmValue = string | string[];

export type FmEntry =
  | { kind: 'kv'; key: string; value: string; source?: string }
  | { kind: 'list'; key: string; items: string[]; source?: string }
  | { kind: 'raw'; text: string };

export interface Note {
  /** Frontmatter fence (`---` or `+++`), or null when the note has none. */
  fence: string | null;
  entries: FmEntry[];
  body: string;
}

const FM_RE = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1\r?\n?/;
const KEY_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const LIST_ITEM_RE = /^\s+-\s*(.*)$/;

export function parseNote(text: string): Note {
  const m = FM_RE.exec(text);
  if (!m) return { fence: null, entries: [], body: text };
  return { fence: m[1], entries: parseEntries(m[2]), body: text.slice(m[0].length) };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseEntries(block: string): FmEntry[] {
  const lines = block.split('\n');
  const out: FmEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    const m = KEY_RE.exec(line);
    if (!m) {
      out.push({ kind: 'raw', text: line });
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();
    if (rest === '') {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const im = LIST_ITEM_RE.exec(lines[j]);
        if (!im) break;
        items.push(unquote(im[1]));
        j++;
      }
      if (items.length > 0) {
        // Keep the original lines so untouched keys are re-emitted byte for byte.
        out.push({ kind: 'list', key, items, source: lines.slice(i, j).join('\n') });
        i = j - 1;
      } else {
        out.push({ kind: 'kv', key, value: '', source: line });
      }
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const items = rest
        .slice(1, -1)
        .split(',')
        .map(s => unquote(s))
        .filter(s => s.length > 0);
      out.push({ kind: 'list', key, items, source: line });
      continue;
    }
    out.push({ kind: 'kv', key, value: unquote(rest), source: line });
  }
  return out;
}

const NUMERIC_RE = /^-?(\d+\.?\d*|\.\d+)$/;
const BOOLEAN_OR_NULL_RE = /^(true|false|null|~|yes|no|on|off)$/i;

/**
 * A plain YAML scalar cannot hold `: `, start with an indicator character, keep
 * surrounding spaces, or look like a number/boolean. Those values are quoted.
 */
function needsQuotes(value: string): boolean {
  if (value === '') return true;
  if (/^[\s]|[\s]$/.test(value)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (value.includes(': ') || /\s#/.test(value) || /[\n\r]/.test(value)) return true;
  if (NUMERIC_RE.test(value) || BOOLEAN_OR_NULL_RE.test(value)) return true;
  return false;
}

/** Serialises a YAML scalar, quoting it only when it would otherwise break. */
export function formatScalar(value: string): string {
  if (!needsQuotes(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function serializeNote(note: Note): string {
  if (note.fence === null) return note.body;
  const lines: string[] = [];
  for (const entry of note.entries) {
    if (entry.kind === 'raw') lines.push(entry.text);
    else if (entry.source !== undefined) lines.push(entry.source);
    else if (entry.kind === 'kv') lines.push(`${entry.key}: ${formatScalar(entry.value)}`);
    else
      lines.push([`${entry.key}:`, ...entry.items.map(i => `  - ${formatScalar(i)}`)].join('\n'));
  }
  return `${note.fence}\n${lines.join('\n')}\n${note.fence}\n${note.body}`;
}

export function getValue(note: Note, key: string): FmValue | undefined {
  const found = note.entries.find(
    e => e.kind !== 'raw' && e.key.toLowerCase() === key.toLowerCase(),
  );
  if (!found) return undefined;
  return found.kind === 'kv' ? found.value : (found as { items: string[] }).items;
}

/** Reads a value as a list, tolerating scalars, comma-separated scalars and block lists. */
export function getList(note: Note, key: string): string[] {
  const value = getValue(note, key);
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return value
    .split(',')
    .map(s => unquote(s))
    .filter(Boolean);
}

/** Sets (or appends) a frontmatter key, creating the frontmatter block if needed. */
export function setValue(note: Note, key: string, value: FmValue): void {
  const entry: FmEntry = Array.isArray(value)
    ? { kind: 'list', key, items: value }
    : { kind: 'kv', key, value };
  const idx = note.entries.findIndex(e => e.kind !== 'raw' && e.key.toLowerCase() === key.toLowerCase());
  if (idx >= 0) note.entries[idx] = entry;
  else note.entries.push(entry);
  if (note.fence === null) note.fence = '---';
}

/**
 * Removes code so its contents are not read as links or tags.
 *
 * Two cases matter in practice and both are easy to get wrong:
 * - fenced blocks, which are often indented because they sit inside a list;
 * - inline spans such as `` `[[enlace]]` ``, which Obsidian does not treat as links.
 */
export function stripCode(text: string): string {
  return (
    text
      // Fenced blocks: ``` or ~~~, indented or not, with an optional info string.
      .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, '')
      // Inline code spans: `x` and ``x`` (content without backticks or line breaks).
      .replace(/(`+)[^`\n]*?\1/g, '')
  );
}

export function tagsOf(note: Note): string[] {
  const fm = [...getList(note, 'tags'), ...getList(note, 'tag')];
  return dedupe(fm.map(t => t.replace(/^#/, '').trim()).filter(Boolean));
}

export function inlineTags(body: string): string[] {
  const found: string[] = [];
  // `\p{L}` and not a Latin-1 range: with `A-Za-z0-9_À-ÿ` the class stopped at
  // the first letter outside it, so `#tamaziɣt` was read as `tamazi` (and
  // Tifinagh tags were dropped whole). The lookbehind mirrors the class, so a
  // tag is never started in the middle of a word in any script.
  const re = /(?<![\p{L}\p{N}_/#])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripCode(body))) !== null) found.push(m[1]);
  return dedupe(found);
}

/** Extracts wikilink targets (alias and heading stripped), ignoring code blocks. */
export function wikilinks(body: string): string[] {
  const found: string[] = [];
  const re = /\[\[([^\[\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripCode(body))) !== null) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) found.push(target);
  }
  return dedupe(found);
}

export function basename(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/i, '');
}

/**
 * Key used to match a link target with a note name.
 *
 * Case-insensitive and Unicode-normalised on purpose: macOS stores filenames
 * as NFD while links are usually written as NFC, so `Planificación` and
 * `Planificación` are the same note — Obsidian resolves them, and so must we.
 */
export function titleKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
