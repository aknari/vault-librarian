/**
 * Normalisation of paths, shared with WikiForge.
 *
 * Guards against the two classic failure modes of model-generated paths:
 * a duplicated base folder (`20-wiki/20-wiki/...`) and escapes (`../`).
 */

export interface NormalizeOptions {
  /** Folder the path is expected to live under; a repeated prefix is stripped. */
  baseDir?: string;
  /** Append `.md` when the path carries no extension. Default: false. */
  ensureMd?: boolean;
}

/** Returns the cleaned vault-relative path, or `null` when empty or unsafe. */
export function normalizeVaultPath(raw: string, opts: NormalizeOptions = {}): string | null {
  if (!raw) return null;

  let p = raw.trim();
  p = p.replace(/^[\["'`<]+/, '').replace(/[\]"'`>]+$/, '').trim();
  if (!p) return null;

  p = p.replace(/\\/g, '/');
  p = p.replace(/^\/+/, '');
  p = p.replace(/^(?:\.\/)+/, '');
  p = p.replace(/\/{2,}/g, '/');

  const segments: string[] = [];
  for (const segment of p.split('/')) {
    const s = segment.trim();
    if (!s || s === '.') continue;
    if (s === '..') return null;
    segments.push(s);
  }

  let out = segments.join('/');
  if (!out) return null;

  const base = (opts.baseDir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (base) {
    while (out.startsWith(`${base}/`)) out = out.slice(base.length + 1);
    if (!out || out === base) return null;
  }

  if (opts.ensureMd && !/\.[a-z0-9]+$/i.test(out)) out += '.md';
  return out;
}
