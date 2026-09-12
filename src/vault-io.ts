import { App, TFile, TFolder } from 'obsidian';
import { normalizeVaultPath } from './paths';

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

/** All files inside a folder (recursively), any extension. */
export function listAllFilesUnder(app: App, folder: string): TFile[] {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  return app.vault
    .getFiles()
    .filter(f => f.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
}
