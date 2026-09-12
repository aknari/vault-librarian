import { App, TFile } from 'obsidian';
import type { LibrarianSettings } from './settings';
import type { CatalogEntry } from './catalog';
import { dedupe, getList, parseNote, serializeNote, setValue } from './markdown';
import { listAllFilesUnder, readText, writeFileSafe } from './vault-io';
import { loadProposals, saveProposals, type ProposalsFile } from './propose';

export const BACKUP_FOLDER = 'backups';
export const MOC_START = '<!-- librarian:moc:start -->';
export const MOC_END = '<!-- librarian:moc:end -->';

export interface BackupFile {
  createdAt: string;
  reason: string;
  files: Array<{ path: string; content: string }>;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Writes every accepted proposal into the note's frontmatter.
 * Snapshots the originals first, so "Undo last apply" is always possible.
 */
export async function applyAccepted(
  app: App,
  settings: LibrarianSettings,
  file: ProposalsFile,
): Promise<{ applied: number; backupPath: string | null }> {
  const accepted = file.proposals.filter(p => p.status === 'accepted');
  if (accepted.length === 0) return { applied: 0, backupPath: null };

  const backup: BackupFile = { createdAt: new Date().toISOString(), reason: 'apply', files: [] };
  for (const proposal of accepted) {
    const content = await readText(app, proposal.path);
    if (content !== null) backup.files.push({ path: proposal.path, content });
  }
  const backupPath = `${settings.dataFolder}/${BACKUP_FOLDER}/${stamp()}.json`;
  await writeFileSafe(app, backupPath, JSON.stringify(backup, null, 2));

  let applied = 0;
  for (const proposal of accepted) {
    const content = await readText(app, proposal.path);
    if (content === null) continue;
    const note = parseNote(content);
    if (proposal.summary) setValue(note, 'summary', proposal.summary);
    if (proposal.tags.length > 0) {
      const existing = getList(note, 'tags');
      const tags =
        settings.tagMode === 'merge' ? dedupe([...existing, ...proposal.tags]) : proposal.tags;
      setValue(note, 'tags', tags);
    }
    await writeFileSafe(app, proposal.path, serializeNote(note));
    proposal.status = 'applied';
    applied++;
  }
  await saveProposals(app, settings, file);
  return { applied, backupPath };
}

/** Restores the most recent backup and returns the restored notes to "accepted". */
export async function undoLastApply(
  app: App,
  settings: LibrarianSettings,
): Promise<{ restored: number; backupPath: string | null }> {
  const backups = listAllFilesUnder(app, `${settings.dataFolder}/${BACKUP_FOLDER}`).filter(
    f => f.extension === 'json',
  );
  const last = backups[backups.length - 1];
  if (!last) return { restored: 0, backupPath: null };

  const text = await readText(app, last.path);
  if (!text) return { restored: 0, backupPath: null };
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(text) as BackupFile;
  } catch {
    return { restored: 0, backupPath: null };
  }

  let restored = 0;
  const paths = new Set<string>();
  for (const entry of parsed.files ?? []) {
    if (typeof entry.content !== 'string') continue;
    await writeFileSafe(app, entry.path, entry.content);
    paths.add(entry.path);
    restored++;
  }

  const proposals = await loadProposals(app, settings);
  for (const proposal of proposals.proposals) {
    if (paths.has(proposal.path) && proposal.status === 'applied') proposal.status = 'accepted';
  }
  await saveProposals(app, settings, proposals);

  const backupFile = app.vault.getAbstractFileByPath(last.path);
  if (backupFile instanceof TFile) await app.vault.delete(backupFile);
  return { restored, backupPath: last.path };
}

function mocBlock(
  node: string,
  titles: string[],
  children: string[],
  mocFileName: string,
): string {
  const lines: string[] = [MOC_START, '', '## Notes', ''];
  lines.push(...[...titles].sort().map(t => `- [[${t}]]`));
  if (titles.length === 0) lines.push('_No notes directly in this folder._');
  if (children.length > 0) {
    lines.push('', '## Subfolders', '');
    for (const child of children.sort()) {
      const name = child.split('/').pop() ?? child;
      lines.push(`- [[${child}/${mocFileName}|${name}]]`);
    }
  }
  lines.push('', MOC_END);
  return lines.join('\n');
}

/**
 * Creates/updates one MOC per folder that has 2+ notes in its subtree.
 * Only the block between the markers is rewritten, so manual notes survive.
 */
export async function generateMocs(
  app: App,
  settings: LibrarianSettings,
  entries: CatalogEntry[],
): Promise<string[]> {
  if (!settings.mocEnabled) return [];

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

  const written: string[] = [];
  for (const node of [...nodes].sort()) {
    const subtree = [...direct.entries()].filter(
      ([folder]) => folder === node || folder.startsWith(`${node}/`),
    );
    const subtreeCount = subtree.reduce((sum, [, titles]) => sum + titles.length, 0);
    if (subtreeCount < 2) continue;

    const titles = direct.get(node) ?? [];
    const children = new Set<string>();
    for (const [folder] of subtree) {
      if (folder === node) continue;
      const first = folder.slice(node.length + 1).split('/')[0];
      if (first) children.add(`${node}/${first}`);
    }

    const path = `${node}/${settings.mocFileName}.md`;
    const existing = (await readText(app, path)) ?? '';
    const block = mocBlock(node, titles, [...children], settings.mocFileName);

    let content: string;
    if (existing.includes(MOC_START) && existing.includes(MOC_END)) {
      content = existing.replace(
        new RegExp(`${escapeRe(MOC_START)}[\\s\\S]*?${escapeRe(MOC_END)}`),
        block,
      );
    } else {
      const header = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n` : `# MOC — ${node}\n\n`;
      content = `${header}${block}\n`;
    }

    const note = parseNote(content);
    const tags = dedupe([...getList(note, 'tags'), settings.mocTag.trim()].filter(Boolean));
    if (tags.length > 0) setValue(note, 'tags', tags);

    await writeFileSafe(app, path, serializeNote(note));
    written.push(path);
  }
  return written;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
