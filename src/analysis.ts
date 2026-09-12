/**
 * Pure analysis: catalogue building, statistics and the audit report.
 * No Obsidian imports, so this module runs (and is tested) in plain Node.
 */
import {
  basename,
  dedupe,
  getValue,
  inlineTags,
  parseNote,
  tagsOf,
  titleKey,
  wikilinks,
} from './markdown';
import { suggestMatch, type Candidate } from './similarity';

export interface RawNote {
  path: string;
  content: string;
  mtime: number;
}

export interface CatalogEntry {
  path: string;
  title: string;
  folder: string;
  tags: string[];
  summary: string | null;
  linksOut: string[];
  linksIn: number;
  headings: number;
  words: number;
  size: number;
  mtime: number;
  hasFrontmatter: boolean;
}

export interface Catalog {
  generatedAt: string;
  entries: CatalogEntry[];
}

export interface CatalogStats {
  total: number;
  withFrontmatter: number;
  untagged: string[];
  orphans: string[];
  noHeadings: string[];
  duplicateTitles: Array<{ title: string; paths: string[] }>;
  brokenLinks: Array<{
    target: string;
    /** Distinct notes that link to the missing target. */
    count: number;
    sources: string[];
    /** Closest existing note title, when one is close enough to be worth suggesting. */
    suggested: Candidate | null;
  }>;
  /** Same breakages, grouped by the folder the broken links live in. */
  brokenByFolder: Array<{ folder: string; targets: number; notes: number }>;
  noiseLinks: Array<{ target: string; count: number }>;
  tagCounts: Array<{ tag: string; count: number }>;
  folders: Array<{ folder: string; notes: number; untagged: number; orphans: number }>;
}

const NOISE_LINK_RE =
  /^(object Object|File|Overdue|pages?\/?|Assets\/|image|.*\.(png|jpe?g|gif|svg|webp|pdf|mp3|mp4)|[0-9]+|DOCS-\d+.*)$/i;

function looksLikeNoise(target: string): boolean {
  if (/^https?:\/\//i.test(target) || target.includes('@')) return true;
  return NOISE_LINK_RE.test(target.trim());
}

/** Builds the catalogue and its statistics from raw notes. */
export function buildCatalog(notes: RawNote[]): { catalog: Catalog; stats: CatalogStats } {
  const entries: CatalogEntry[] = notes.map(raw => {
    const note = parseNote(raw.content);
    const summaryValue = getValue(note, 'summary');
    const summary =
      typeof summaryValue === 'string' && summaryValue.trim()
        ? summaryValue.trim()
        : Array.isArray(summaryValue) && summaryValue.length > 0
          ? summaryValue[0]
          : null;
    return {
      path: raw.path,
      title: basename(raw.path),
      folder: raw.path.split('/').slice(0, -1).join('/'),
      tags: dedupe([...tagsOf(note), ...inlineTags(note.body)]),
      summary,
      linksOut: wikilinks(note.body),
      linksIn: 0,
      headings: (note.body.match(/^#{1,6}\s/gm) ?? []).length,
      words: note.body.trim() ? note.body.trim().split(/\s+/).length : 0,
      size: raw.content.length,
      mtime: raw.mtime,
      hasFrontmatter: note.fence !== null,
    };
  });

  // Resolve incoming links by note title (case- and Unicode-normalisation-insensitive).
  const byTitle = new Map<string, CatalogEntry>();
  for (const entry of entries) byTitle.set(titleKey(entry.title), entry);

  const broken = new Map<string, Set<string>>();
  const noise = new Map<string, number>();
  for (const entry of entries) {
    for (const target of entry.linksOut) {
      const dest = byTitle.get(titleKey(basename(target)));
      if (dest) {
        dest.linksIn++;
        continue;
      }
      if (looksLikeNoise(target)) {
        noise.set(target, (noise.get(target) ?? 0) + 1);
        continue;
      }
      const sources = broken.get(target) ?? new Set<string>();
      sources.add(entry.path);
      broken.set(target, sources);
    }
  }

  const candidates: Candidate[] = entries.map(e => ({ title: e.title, path: e.path }));

  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  const titleMap = new Map<string, string[]>();
  for (const entry of entries) {
    const key = titleKey(entry.title);
    titleMap.set(key, [...(titleMap.get(key) ?? []), entry.path]);
  }
  const duplicateTitles = [...titleMap.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([title, paths]) => ({ title, paths }));

  const untagged = entries.filter(e => e.tags.length === 0).map(e => e.path);
  const orphans = entries.filter(e => e.linksIn === 0 && e.linksOut.length === 0).map(e => e.path);
  const noHeadings = entries.filter(e => e.headings === 0).map(e => e.path);

  const folderMap = new Map<string, { folder: string; notes: number; untagged: number; orphans: number }>();
  for (const entry of entries) {
    const row = folderMap.get(entry.folder) ?? {
      folder: entry.folder,
      notes: 0,
      untagged: 0,
      orphans: 0,
    };
    row.notes++;
    if (entry.tags.length === 0) row.untagged++;
    if (entry.linksIn === 0 && entry.linksOut.length === 0) row.orphans++;
    folderMap.set(entry.folder, row);
  }

  const brokenLinks = [...broken.entries()]
    .map(([target, sources]) => ({
      target,
      count: sources.size,
      sources: [...sources].sort(),
      suggested: suggestMatch(target, candidates),
    }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));

  const folderRows = new Map<string, { folder: string; targets: Set<string>; notes: Set<string> }>();
  for (const item of brokenLinks) {
    for (const source of item.sources) {
      const folder = source.split('/').slice(0, -1).join('/');
      const row = folderRows.get(folder) ?? { folder, targets: new Set<string>(), notes: new Set<string>() };
      row.targets.add(item.target);
      row.notes.add(source);
      folderRows.set(folder, row);
    }
  }

  const stats: CatalogStats = {
    total: entries.length,
    withFrontmatter: entries.filter(e => e.hasFrontmatter).length,
    untagged,
    orphans,
    noHeadings,
    duplicateTitles,
    brokenLinks,
    brokenByFolder: [...folderRows.values()]
      .map(row => ({ folder: row.folder || '(root)', targets: row.targets.size, notes: row.notes.size }))
      .sort((a, b) => b.notes - a.notes || a.folder.localeCompare(b.folder)),
    noiseLinks: [...noise.entries()]
      .map(([target, count]) => ({ target, count }))
      .sort((a, b) => b.count - a.count),
    tagCounts: [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    folders: [...folderMap.values()].sort((a, b) => b.notes - a.notes),
  };

  return { catalog: { generatedAt: new Date().toISOString(), entries }, stats };
}

function link(path: string): string {
  return `[[${path.replace(/\.md$/i, '')}]]`;
}

function capped(paths: string[], max: number): string {
  const shown = paths.slice(0, max).map(p => `- ${link(p)}`);
  if (paths.length > max) shown.push(`- …and ${paths.length - max} more.`);
  return shown.join('\n');
}

/** Renders the deterministic audit report (no LLM involved). */
export function renderAudit(stats: CatalogStats, maxList = 40, maxBroken = 200, maxSources = 8): string {
  const pct = (n: number): string =>
    stats.total > 0 ? `${Math.round((n / stats.total) * 100)}%` : '0%';
  const lines: string[] = [];

  lines.push('# Vault report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Notes analysed | ${stats.total} |`);
  lines.push(`| Without any tag | ${stats.untagged.length} (${pct(stats.untagged.length)}) |`);
  lines.push(`| Without frontmatter | ${stats.total - stats.withFrontmatter} |`);
  lines.push(
    `| Orphans (0 links in and out) | ${stats.orphans.length} (${pct(stats.orphans.length)}) |`,
  );
  lines.push(`| Without headings | ${stats.noHeadings.length} |`);
  lines.push(`| Duplicate titles | ${stats.duplicateTitles.length} |`);
  lines.push(`| Broken links (missing target) | ${stats.brokenLinks.length} |`);
  lines.push(`| Distinct tags | ${stats.tagCounts.length} |`);
  lines.push('');

  lines.push('## By folder');
  lines.push('');
  lines.push('| Folder | Notes | Untagged | Orphans |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const row of stats.folders) {
    lines.push(`| ${row.folder || '(root)'} | ${row.notes} | ${row.untagged} | ${row.orphans} |`);
  }
  lines.push('');

  if (stats.tagCounts.length > 0) {
    lines.push('## Most used tags');
    lines.push('');
    for (const { tag, count } of stats.tagCounts.slice(0, maxList)) {
      lines.push(`- #${tag} — ${count}`);
    }
    const singles = stats.tagCounts.filter(t => t.count === 1).length;
    if (singles > 0) {
      lines.push('');
      lines.push(`> ${singles} tag(s) are used only once: candidates to merge or drop.`);
    }
    lines.push('');
  }

  const sections: Array<[string, string[]]> = [
    ['Untagged notes', stats.untagged],
    ['Orphan notes', stats.orphans],
    ['Notes without headings', stats.noHeadings],
  ];
  for (const [title, paths] of sections) {
    lines.push(`## ${title} (${paths.length})`);
    lines.push('');
    lines.push(paths.length > 0 ? capped(paths, maxList) : '_None._');
    lines.push('');
  }

  lines.push(`## Duplicate titles (${stats.duplicateTitles.length})`);
  lines.push('');
  if (stats.duplicateTitles.length === 0) lines.push('_None._');
  for (const dup of stats.duplicateTitles) {
    lines.push(`- **${dup.title}**: ${dup.paths.map(link).join(' · ')}`);
  }
  lines.push('');

  if (stats.brokenByFolder.length > 0) {
    lines.push('## Broken links by folder');
    lines.push('');
    lines.push('| Folder | Notes with broken links | Distinct targets |');
    lines.push('| --- | ---: | ---: |');
    for (const row of stats.brokenByFolder) {
      lines.push(`| ${row.folder} | ${row.notes} | ${row.targets} |`);
    }
    lines.push('');
  }

  lines.push(`## Broken links (${stats.brokenLinks.length})`);
  lines.push('');
  lines.push('Each entry lists the notes that link to a missing target, and a suggestion when a note title looks close enough.');
  lines.push('');
  if (stats.brokenLinks.length === 0) lines.push('_None._');
  for (const { target, count, sources, suggested } of stats.brokenLinks.slice(0, maxBroken)) {
    lines.push(`- \`${target}\` — ${count} note(s)`);
    const shown = sources.slice(0, maxSources).map(s => link(s)).join(' · ');
    const more = sources.length > maxSources ? ` · …and ${sources.length - maxSources} more` : '';
    lines.push(`  - from: ${shown}${more}`);
    if (suggested) lines.push(`  - did you mean ${link(suggested.path)}?`);
  }
  if (stats.brokenLinks.length > maxBroken) {
    lines.push(`- …and ${stats.brokenLinks.length - maxBroken} more targets.`);
  }
  lines.push('');

  if (stats.noiseLinks.length > 0) {
    lines.push(`## Template noise (${stats.noiseLinks.length})`);
    lines.push('');
    lines.push('Targets that look generated by templates or queries, not real notes:');
    lines.push('');
    for (const { target, count } of stats.noiseLinks.slice(0, maxList)) {
      lines.push(`- \`${target}\` — ${count}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
