import { App } from 'obsidian';
import type { LibrarianSettings } from './settings';
import { buildCatalog, type Catalog, type CatalogStats } from './analysis';
import { readText, writeFileSafe } from './vault-io';

export type { Catalog, CatalogEntry, CatalogStats, RawNote } from './analysis';
export { buildCatalog, renderAudit } from './analysis';

export const CATALOG_FILE = 'catalog.json';

/** Reads the vault and returns the raw material for the catalogue. */
export async function collectNotes(
  app: App,
  settings: LibrarianSettings,
): Promise<import('./analysis').RawNote[]> {
  const dataFolder = settings.dataFolder.replace(/^\/+|\/+$/g, '');
  const mocFile = `${settings.mocFileName}.md`.toLowerCase();
  const reportPath = settings.reportPath;

  const files = app.vault
    .getMarkdownFiles()
    .filter(file => {
      if (file.path === reportPath) return false;
      if (dataFolder && file.path.startsWith(`${dataFolder}/`)) return false;
      if (file.name.toLowerCase() === mocFile) return false;
      const segments = file.path.split('/').slice(0, -1);
      return !segments.some(segment => settings.excludedFolders.includes(segment));
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const notes: import('./analysis').RawNote[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    try {
      notes.push({
        path: file.path,
        content: await app.vault.cachedRead(file),
        mtime: file.stat.mtime,
      });
    } catch (e) {
      // A dangling symlink or an unreadable file must not break the whole scan.
      skipped.push(file.path);
      console.warn('Vault Librarian: unreadable note, skipped:', file.path, e);
    }
  }
  if (skipped.length > 0) console.warn(`Vault Librarian: ${skipped.length} unreadable note(s) skipped.`);
  return notes;
}

/** Scans the vault and persists the catalogue. */
export async function scanVault(
  app: App,
  settings: LibrarianSettings,
): Promise<{ catalog: Catalog; stats: CatalogStats }> {
  const { catalog, stats } = buildCatalog(await collectNotes(app, settings));
  await saveCatalog(app, settings, catalog);
  return { catalog, stats };
}

export async function saveCatalog(
  app: App,
  settings: LibrarianSettings,
  catalog: Catalog,
): Promise<void> {
  await writeFileSafe(app, `${settings.dataFolder}/${CATALOG_FILE}`, JSON.stringify(catalog, null, 2));
}

export async function loadCatalog(
  app: App,
  settings: LibrarianSettings,
): Promise<Catalog | null> {
  const text = await readText(app, `${settings.dataFolder}/${CATALOG_FILE}`);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Catalog;
    return Array.isArray(parsed?.entries) ? parsed : null;
  } catch {
    return null;
  }
}
