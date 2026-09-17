import { App, TFile } from 'obsidian';
import type { LibrarianSettings } from './settings';
import type { CatalogEntry } from './catalog';
import { dedupe, getList, parseNote, serializeNote, setValue } from './markdown';
import { MOC_END, MOC_START, mocPlan } from './moc';
import { listAllFilesUnder, moveNote, readText, writeFileSafe } from './vault-io';
import { planMove } from './relocation';
import { loadProposals, saveProposals, type ProposalsFile } from './propose';

export const BACKUP_FOLDER = 'backups';

// The plan and the markers live in a pure module so they can be unit-tested;
// re-exported here so anything importing them from `apply` keeps working.
export { MOC_END, MOC_START } from './moc';
export type { MocPlanItem } from './moc';

export interface BackupFile {
  createdAt: string;
  reason: string;
  /**
   * `movedTo` is the one thing undo cannot work out on its own: it says the note
   * is no longer at `path`, so restoring the content there would leave a copy
   * behind and put the vault back with two notes instead of one.
   */
  files: Array<{ path: string; content: string; movedTo?: string }>;
}

export interface ApplySummary {
  applied: number;
  /** New paths of the notes that changed folder. */
  moved: string[];
  /** Notes left in place because their destination was taken. */
  blocked: string[];
  backupPath: string | null;
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
): Promise<ApplySummary> {
  const accepted = file.proposals.filter(p => p.status === 'accepted');
  if (accepted.length === 0) return { applied: 0, moved: [], blocked: [], backupPath: null };

  const backup: BackupFile = { createdAt: new Date().toISOString(), reason: 'apply', files: [] };
  for (const proposal of accepted) {
    const content = await readText(app, proposal.path);
    if (content !== null) backup.files.push({ path: proposal.path, content });
  }
  const backupPath = `${settings.dataFolder}/${BACKUP_FOLDER}/${stamp()}.json`;
  await writeFileSafe(app, backupPath, JSON.stringify(backup, null, 2));

  const moved: string[] = [];
  const blocked: string[] = [];
  let applied = 0;
  for (const proposal of accepted) {
    const content = await readText(app, proposal.path);
    if (content === null) continue;
    const entry = backup.files.find(f => f.path === proposal.path);
    const note = parseNote(content);
    if (proposal.summary) setValue(note, 'summary', proposal.summary);
    if (proposal.tags.length > 0) {
      const existing = getList(note, 'tags');
      const tags =
        settings.tagMode === 'merge' ? dedupe([...existing, ...proposal.tags]) : proposal.tags;
      setValue(note, 'tags', tags);
    }
    await writeFileSafe(app, proposal.path, serializeNote(note));
    // The move is last, after the content is written: it is the step that can
    // fail (a file already sitting at the destination), and failing it must not
    // cost the tags that were accepted for that same note.
    const destination = proposal.moveTo ? planMove(proposal.path, proposal.moveTo) : null;
    if (destination) {
      const movedFile = await moveNote(app, proposal.path, destination.to);
      if (movedFile) {
        if (entry) entry.movedTo = destination.to;
        // The queue is keyed by path, so it has to follow the note. Without
        // this the proposal would point at a file that no longer exists.
        proposal.path = destination.to;
        moved.push(destination.to);
      } else {
        blocked.push(proposal.path);
      }
    }
    proposal.status = 'applied';
    applied++;
  }
  // Rewritten when something moved, so undo knows to take the note back to
  // `path` before restoring its content there.
  if (moved.length > 0) await writeFileSafe(app, backupPath, JSON.stringify(backup, null, 2));
  await saveProposals(app, settings, file);
  return { applied, moved, blocked, backupPath };
}

/** Restores the most recent backup and returns the restored notes to "accepted". */
export async function undoLastApply(
  app: App,
  settings: LibrarianSettings,
): Promise<{ restored: number; blocked: number; backupPath: string | null }> {
  const backups = listAllFilesUnder(app, `${settings.dataFolder}/${BACKUP_FOLDER}`).filter(
    f => f.extension === 'json',
  );
  const last = backups[backups.length - 1];
  if (!last) return { restored: 0, blocked: 0, backupPath: null };

  const text = await readText(app, last.path);
  if (!text) return { restored: 0, blocked: 0, backupPath: null };
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(text) as BackupFile;
  } catch {
    return { restored: 0, blocked: 0, backupPath: null };
  }

  let restored = 0;
  let blocked = 0;
  const paths = new Set<string>();
  /** Where a note is now → where it was, so the queue can follow it back. */
  const backHome = new Map<string, string>();
  for (const entry of parsed.files ?? []) {
    if (typeof entry.content !== 'string') continue;
    if (entry.movedTo !== undefined) {
      const file = app.vault.getAbstractFileByPath(entry.movedTo);
      // Either the note is no longer at the destination, or something else took
      // its old path while it was away. Both mean the vault is not as apply left
      // it, and writing the old content back would add a note instead of
      // restoring one — so this entry is left alone and counted.
      if (!(file instanceof TFile) || app.vault.getAbstractFileByPath(entry.path) !== null) {
        blocked++;
        continue;
      }
      await app.fileManager.renameFile(file, entry.path);
      backHome.set(entry.movedTo, entry.path);
    }
    await writeFileSafe(app, entry.path, entry.content);
    paths.add(entry.path);
    restored++;
  }

  const proposals = await loadProposals(app, settings);
  for (const proposal of proposals.proposals) {
    const home = backHome.get(proposal.path) ?? proposal.path;
    if (!paths.has(home) || proposal.status !== 'applied') continue;
    proposal.status = 'accepted';
    // Back in the queue at the folder it was moved from, ready to be applied
    // again (or edited) instead of pointing at a path that no longer exists.
    proposal.path = home;
  }
  await saveProposals(app, settings, proposals);

  const backupFile = app.vault.getAbstractFileByPath(last.path);
  if (backupFile instanceof TFile) await app.vault.delete(backupFile);
  return { restored, blocked, backupPath: last.path };
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
