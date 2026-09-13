import { App } from 'obsidian';
import type { LibrarianSettings } from './settings';
import {
  buildCatalog,
  type Catalog,
  type CatalogStats,
  type RawNote,
  type UnscannedTitle,
} from './analysis';
import { basename } from './markdown';
import { readText, writeFileSafe } from './vault-io';

export type { Catalog, CatalogEntry, CatalogStats, RawNote, UnscannedTitle } from './analysis';
export { buildCatalog, renderAudit } from './analysis';

export const CATALOG_FILE = 'catalog.json';

export interface CollectedNotes {
  notes: RawNote[];
  /**
   * Titles the scan did not read, so a link to one is not called broken.
   *
   * Only the names are collected: reading the contents of an excluded folder
   * would defeat the point of excluding it.
   */
  unscanned: UnscannedTitle[];
}

/** Reads the vault and returns the raw material for the catalogue. */
export async function collectNotes(
  app: App,
  settings: LibrarianSettings,
): Promise<CollectedNotes> {
  const dataFolder = settings.dataFolder.replace(/^\/+|\/+$/g, '');
  const mocFile = `${settings.mocFileName}.md`.toLowerCase();
  const reportPath = settings.reportPath;

  const isOutside = (path: string): boolean => {
    if (path === reportPath) return true;
    if (dataFolder && path.startsWith(`${dataFolder}/`)) return true;
    const segments = path.split('/').slice(0, -1);
    return segments.some(segment => settings.excludedFolders.includes(segment));
  };

  const files = app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
  const notes: RawNote[] = [];
  const unscanned: UnscannedTitle[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const isMoc = file.name.toLowerCase() === mocFile;
    if (isOutside(file.path)) {
      // A MOC is a link source, not a note to audit; one inside an excluded
      // folder is out of reach entirely. Every other note contributes its name
      // and nothing else.
      if (!isMoc && file.path !== reportPath) {
        unscanned.push({ title: basename(file.path), reason: 'excluded' });
      }
      continue;
    }
    try {
      notes.push({
        path: file.path,
        content: await app.vault.cachedRead(file),
        mtime: file.stat.mtime,
        // Kept out of the catalogue, but its links still count: otherwise the
        // orphan figure cannot see the MOCs the plugin just wrote.
        ...(isMoc ? { role: 'link-source' as const } : {}),
      });
    } catch (e) {
      // A dangling symlink or an unreadable file must not break the whole scan.
      // Its name is still worth keeping: the file exists, so a link to it is not
      // a missing target, and *why* it was skipped is a real finding.
      skipped.push(file.path);
      unscanned.push({ title: basename(file.path), reason: 'unreadable' });
      console.warn('Vault Librarian: unreadable note, skipped:', file.path, e);
    }
  }
  if (skipped.length > 0) console.warn(`Vault Librarian: ${skipped.length} unreadable note(s) skipped.`);
  return { notes, unscanned };
}

/** Scans the vault and persists the catalogue. */
export async function scanVault(
  app: App,
  settings: LibrarianSettings,
): Promise<{ catalog: Catalog; stats: CatalogStats }> {
  const { notes, unscanned } = await collectNotes(app, settings);
  const { catalog, stats } = buildCatalog(notes, { unscanned });
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
