/**
 * The map-of-content plan: which MOC notes to write and what each one contains.
 *
 * Pure module — no Obsidian — so the rule that decides who links to whom is
 * testable. That rule has been wrong once already: a parent linked
 * `[[<child>/_MOC]]` for *every* child folder while only folders with 2+ notes
 * got a MOC, so the smaller ones produced a link to a note that was never
 * created and their note was left with no incoming link at all.
 */
import type { CatalogEntry } from './analysis';

export const MOC_START = '<!-- librarian:moc:start -->';
export const MOC_END = '<!-- librarian:moc:end -->';

export interface MocPlanItem {
  /** Folder the MOC belongs to. */
  folder: string;
  /** Vault path of the MOC note itself. */
  path: string;
  /** The block that goes between the markers. */
  block: string;
}

/** A note pulled into a parent MOC because its own folder got none. */
interface LooseNote {
  title: string;
  folder: string;
}

/**
 * A note link, always written path-first with the title as the alias.
 *
 * The alias keeps the MOC reading exactly as before, while the path removes the
 * ambiguity of a bare title: two folders in this vault really do hold a note
 * called "01-materias", and a bare `[[01-materias]]` then picks one of them
 * arbitrarily — deciding by accident which of the two stops being an orphan.
 */
function noteLink(folder: string, title: string): string {
  return `- [[${folder}/${title}|${title}]]`;
}

function mocBlock(
  folder: string,
  titles: string[],
  children: string[],
  loose: LooseNote[],
  mocFileName: string,
): string {
  const lines: string[] = [MOC_START, '', '## Notes', ''];
  const direct = [...titles].sort().map(t => noteLink(folder, t));
  lines.push(...(direct.length > 0 ? direct : ['_No notes directly in this folder._']));
  if (children.length > 0) {
    lines.push('', '## Subfolders', '');
    for (const child of [...children].sort()) {
      const name = child.split('/').pop() ?? child;
      lines.push(`- [[${child}/${mocFileName}|${name}]]`);
    }
  }
  if (loose.length > 0) {
    lines.push('', '## Subfolder notes', '');
    for (const item of [...loose].sort((a, b) => a.title.localeCompare(b.title))) {
      lines.push(noteLink(item.folder, item.title));
    }
  }
  lines.push('', MOC_END);
  return lines.join('\n');
}

/**
 * One MOC per folder holding 2+ notes in its subtree.
 *
 * A folder below that threshold gets none, and its note is then listed in the
 * nearest ancestor that does — so every note ends up reachable from some MOC,
 * which is the whole point of the step. A folder can never hold fewer notes than
 * a descendant of it, so a child without a MOC has no written descendant either,
 * and one level of flattening is always enough.
 */
export function mocPlan(entries: CatalogEntry[], mocFileName: string): MocPlanItem[] {
  const direct = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.folder) continue;
    direct.set(entry.folder, [...(direct.get(entry.folder) ?? []), entry.title]);
  }

  const nodes = new Set<string>();
  for (const folder of direct.keys()) {
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) nodes.add(parts.slice(0, i).join('/'));
  }

  const inSubtree = (node: string): Array<[string, string[]]> =>
    [...direct.entries()].filter(([folder]) => folder === node || folder.startsWith(`${node}/`));
  const noteCount = (node: string): number =>
    inSubtree(node).reduce((sum, [, titles]) => sum + titles.length, 0);

  const written = new Set([...nodes].filter(node => noteCount(node) >= 2));

  const plan: MocPlanItem[] = [];
  for (const node of [...written].sort()) {
    const children: string[] = [];
    const loose: LooseNote[] = [];
    for (const [folder] of inSubtree(node)) {
      if (folder === node) continue;
      const first = folder.slice(node.length + 1).split('/')[0];
      if (!first) continue;
      const child = `${node}/${first}`;
      if (written.has(child)) {
        if (!children.includes(child)) children.push(child);
        continue;
      }
      for (const title of direct.get(folder) ?? []) loose.push({ title, folder });
    }
    plan.push({
      folder: node,
      path: `${node}/${mocFileName}.md`,
      block: mocBlock(node, direct.get(node) ?? [], children, loose, mocFileName),
    });
  }
  return plan;
}
