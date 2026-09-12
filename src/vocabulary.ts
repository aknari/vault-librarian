/**
 * The tag vocabulary: a small set of facets, each with an explicit list of
 * values. Tags are nested (`proyecto/lisa`), so a facet can never bleed into
 * another one and synonyms cannot multiply.
 *
 * Pure module: no Obsidian imports, fully unit-testable.
 */

export interface Facet {
  name: string;
  values: string[];
}

export interface Vocabulary {
  facets: Facet[];
}

export function emptyVocabulary(): Vocabulary {
  return { facets: [] };
}

/** Values are lowercase, hyphenated and without a leading `#`. */
export function normalizeValue(value: string): string {
  return value
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

export function normalizeFacetName(name: string): string {
  return normalizeValue(name).replace(/\//g, '-');
}

export function tagFor(facet: string, value: string): string {
  return `${normalizeFacetName(facet)}/${normalizeValue(value)}`;
}

export function listTags(vocabulary: Vocabulary): string[] {
  const out: string[] = [];
  for (const facet of vocabulary.facets) {
    for (const value of facet.values) out.push(tagFor(facet.name, value));
  }
  return [...new Set(out)].sort();
}

export function tagCount(vocabulary: Vocabulary): number {
  return listTags(vocabulary).length;
}

/** Splits proposed tags into the ones the vocabulary knows and the rest. */
export function validateTags(
  vocabulary: Vocabulary,
  tags: string[],
): { valid: string[]; unknown: string[] } {
  const known = new Set(listTags(vocabulary));
  const valid: string[] = [];
  const unknown: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    if (known.has(tag)) valid.push(tag);
    else unknown.push(tag);
  }
  return { valid: [...new Set(valid)], unknown: [...new Set(unknown)] };
}

/** Normalises a whole tag (`Faceta/Valor`), keeping the facet separators. */
export function normalizeTag(tag: string): string {
  const cleaned = tag.trim().replace(/^#/, '');
  if (!cleaned) return '';
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return normalizeValue(parts[0]);
  return `${normalizeFacetName(parts[0])}/${parts.slice(1).map(normalizeValue).join('/')}`;
}

/** Adds every value of `facetName` to the vocabulary (used by "import a facet"). */
export function importValues(
  vocabulary: Vocabulary,
  facetName: string,
  values: string[],
): number {
  const name = normalizeFacetName(facetName);
  if (!name) return 0;
  let facet = vocabulary.facets.find(f => f.name === name);
  if (!facet) {
    facet = { name, values: [] };
    vocabulary.facets.push(facet);
  }
  const existing = new Set(facet.values);
  let added = 0;
  for (const value of values) {
    const v = normalizeValue(value);
    if (!v || existing.has(v)) continue;
    facet.values.push(v);
    existing.add(v);
    added++;
  }
  facet.values.sort();
  return added;
}

/** Adds unknown tag values under a catch-all facet, so nothing is silently lost. */
export function addUnknownTags(
  vocabulary: Vocabulary,
  tags: string[],
  facetName = 'otros',
): number {
  const name = normalizeFacetName(facetName);
  const byFacet = new Map<string, string[]>();
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const [facet, ...rest] = tag.split('/');
    const value = rest.length > 0 ? rest.join('/') : facet;
    const target = rest.length > 0 && vocabulary.facets.some(f => f.name === facet) ? facet : name;
    const list = byFacet.get(target) ?? [];
    list.push(value);
    byFacet.set(target, list);
  }
  let added = 0;
  for (const [facet, values] of byFacet) added += importValues(vocabulary, facet, values);
  return added;
}

/** Defensive load from an untrusted JSON value. */
export function parseVocabulary(raw: unknown): Vocabulary {
  const out = emptyVocabulary();
  if (!raw || typeof raw !== 'object') return out;
  const facets = (raw as { facets?: unknown }).facets;
  if (!Array.isArray(facets)) return out;
  for (const facet of facets) {
    if (!facet || typeof facet !== 'object') continue;
    const name = normalizeFacetName(String((facet as { name?: unknown }).name ?? ''));
    if (!name) continue;
    const rawValues = (facet as { values?: unknown }).values;
    const values = Array.isArray(rawValues)
      ? rawValues.map(v => normalizeValue(String(v))).filter(Boolean)
      : [];
    const existing = out.facets.find(f => f.name === name);
    if (existing) existing.values = [...new Set([...existing.values, ...values])].sort();
    else out.facets.push({ name, values: [...new Set(values)].sort() });
  }
  return out;
}

/** Removes empty facets and duplicate values, in place. */
export function tidyVocabulary(vocabulary: Vocabulary): Vocabulary {
  const cleaned: Facet[] = [];
  for (const facet of vocabulary.facets) {
    const name = normalizeFacetName(facet.name);
    if (!name) continue;
    const values = [...new Set(facet.values.map(normalizeValue).filter(Boolean))].sort();
    if (values.length === 0) continue;
    const existing = cleaned.find(f => f.name === name);
    if (existing) existing.values = [...new Set([...existing.values, ...values])].sort();
    else cleaned.push({ name, values });
  }
  cleaned.sort((a, b) => a.name.localeCompare(b.name));
  return { facets: cleaned };
}

/** Compact description of the vocabulary, used inside the prompt. */
export function vocabularyPrompt(vocabulary: Vocabulary): string {
  const tidy = tidyVocabulary(vocabulary);
  if (tidy.facets.length === 0) return '(no vocabulary defined yet)';
  return tidy.facets
    .map(f => `- ${f.name}: ${f.values.join(', ')}`)
    .join('\n');
}
