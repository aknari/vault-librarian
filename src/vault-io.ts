import { App, TFile, TFolder } from 'obsidian';
import { normalizeVaultPath } from './paths';
import { effectiveRoots, isCandidateFolder, isInsideRoots } from './relocation';
import type { LibrarianSettings } from './settings';

/** Reads a vault file, or null when it does not exist/is not a file. */
export async function readText(app: App, path: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  return app.vault.read(file);
}

/** Creates/overwrites a vault file, creating parent folders as needed. */
export async function writeFileSafe(app: App, path: string, content: string): Promise<void> {
  const safe = normalizeVaultPath(path);
  if (!safe) throw new Error(`Vault Librarian: refusing to write an unsafe path: "${path}"`);
  const existing = app.vault.getAbstractFileByPath(safe);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  await ensureFolder(app, safe.substring(0, safe.lastIndexOf('/')));
  await app.vault.create(safe, content);
}

/** Creates a folder (and its parents) when missing. */
export async function ensureFolder(app: App, folder: string): Promise<void> {
  const safe = normalizeVaultPath(folder);
  if (!safe) return;
  const parts = safe.split('/');
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) await app.vault.createFolder(current);
    else if (!(existing instanceof TFolder)) return; // a file blocks the path
  }
}

/** All markdown files inside a folder (recursively). */
export function listFilesUnder(app: App, folder: string): TFile[] {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  return app.vault
    .getMarkdownFiles()
    .filter(f => f.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Moves a note, rewriting the links that point at it.
 *
 * `fileManager.renameFile` and not `vault.rename`: the file manager is what
 * updates the wikilinks in the other notes, which is the whole reason a move
 * belongs to the plugin and not to a file browser. The note keeps its name, so
 * ordinary `[[title]]` links are untouched and only path-qualified ones change.
 *
 * Returns null when the move cannot be made — destination already taken, the
 * note is not where it was said to be, or the destination folder is gone.
 * Renaming the note to "… 1" to squeeze it in would be a rename nobody asked
 * for, on top of a move.
 *
 * The destination folder is *required to exist* rather than created: the folder
 * was validated when the suggestion was made, so one missing now was renamed or
 * deleted since, and re-creating it would file the note into a folder that is
 * not the one anybody chose.
 */
export async function moveNote(app: App, from: string, to: string): Promise<TFile | null> {
  const file = app.vault.getAbstractFileByPath(from);
  if (!(file instanceof TFile)) return null;
  if (app.vault.getAbstractFileByPath(to) !== null) return null;
  const folder = to.substring(0, to.lastIndexOf('/'));
  if (folder !== '' && !(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) return null;
  await app.fileManager.renameFile(file, to);
  return file;
}

/** Every folder of the vault, vault-root relative and sorted. */
export function listFolders(app: App): string[] {
  return app.vault
    .getAllLoadedFiles()
    .filter((file): file is TFolder => file instanceof TFolder)
    .map(folder => folder.path.replace(/^\/+|\/+$/g, ''))
    .filter(path => path !== '')
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The folders a note may be moved to.
 *
 * Three filters, in this order: the roots in the settings (the notes folders,
 * unless destinations were named separately), the `excludedFolders` the scan
 * already uses, and the plugin's own data folder — a folder this plugin is told
 * not to read never comes back as a place to write.
 *
 * Recomputed per dialog rather than cached: creating a folder in Obsidian and
 * opening the review panel should offer it.
 */
export function folderTargets(app: App, settings: LibrarianSettings): string[] {
  const roots = effectiveRoots(settings.noteFolders, settings.moveFolders);
  return selectableFolders(app, settings).filter(
    path => roots.length === 0 || isInsideRoots(path, roots),
  );
}

/**
 * The folders the settings are allowed to name.
 *
 * Without the roots filter, on purpose: this is the list the folder picker
 * draws, and drawing it through the current selection would leave you unable to
 * add a root that is not already inside one.
 */
export function selectableFolders(app: App, settings: LibrarianSettings): string[] {
  return listFolders(app).filter(path =>
    isCandidateFolder(path, settings.excludedFolders, [settings.dataFolder]),
  );
}

/** All files inside a folder (recursively), any extension. */
export function listAllFilesUnder(app: App, folder: string): TFile[] {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  return app.vault
    .getFiles()
    .filter(f => f.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
}
