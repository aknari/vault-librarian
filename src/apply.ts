import { App, TFile } from 'obsidian';
import type { LibrarianSettings } from './settings';
import type { CatalogEntry } from './catalog';
import { dedupe, getList, parseNote, serializeNote, setValue } from './markdown';
import { MOC_END, MOC_START, mocPlan } from './moc';
import { listAllFilesUnder, readText, writeFileSafe } from './vault-io';
import { loadProposals, saveProposals, type ProposalsFile } from './propose';

export const BACKUP_FOLDER = 'backups';

// The plan and the markers live in a pure module so they can be unit-tested;
// re-exported here so anything importing them from `apply` keeps working.
export { MOC_END, MOC_START } from './moc';
export type { MocPlanItem } from './moc';

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

  const written: string[] = [];
  for (const item of mocPlan(entries, settings.mocFileName)) {
    const existing = (await readText(app, item.path)) ?? '';

    let content: string;
    if (existing.includes(MOC_START) && existing.includes(MOC_END)) {
      content = existing.replace(
        new RegExp(`${escapeRe(MOC_START)}[\\s\\S]*?${escapeRe(MOC_END)}`),
        item.block,
      );
    } else {
      const header = existing.trim()
        ? `${existing.replace(/\s*$/, '')}\n\n`
        : `# MOC — ${item.folder}\n\n`;
      content = `${header}${item.block}\n`;
    }

    const note = parseNote(content);
    const tags = dedupe([...getList(note, 'tags'), settings.mocTag.trim()].filter(Boolean));
    if (tags.length > 0) setValue(note, 'tags', tags);

    await writeFileSafe(app, item.path, serializeNote(note));
    written.push(item.path);
  }
  return written;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
