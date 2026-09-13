/**
 * The tag vocabulary: a small set of facets, each with an explicit list of
 * values. Tags are nested (`proyecto/lisa`), so a facet can never bleed into
 * another one and synonyms cannot multiply.
 *
 * Pure module: no Obsidian imports, fully unit-testable.
 */

export interface Facet {
  name: string;
  /**
   * What the facet means, in the vault owner's own words.
   *
   * A bare list of values cannot say whether `materia` holds university
   * subjects or anything a note is about, so a model handed only the list has
   * to guess — and its guess is the nearest value it can see. That is how
   * `materia/sistemas-digitales` ended up on notes of a personal project that
   * is not part of any subject.
   */
  description?: string;
  values: string[];
  /**
   * What each value means, keyed by the normalised value.
   *
   * Needed where one facet gathers unrelated things: `tema` holds `i18n`
   * (internationalisation *of software*), `obsidian` (the application itself)
   * and `tamazight` (a language), and a facet-level description cannot tell
   * them apart. A note listing Latvian links got `tema/i18n` because nothing
   * said that `i18n` is not simply "languages".
   */
  valueDescriptions?: Record<string, string>;
}

export interface Vocabulary {
  facets: Facet[];
}

export function emptyVocabulary(): Vocabulary {
  return { facets: [] };
}

/** The description stored for one value, or `''`. */
export function valueDescription(facet: Facet, value: string): string {
  return (facet.valueDescriptions?.[normalizeValue(value)] ?? '').trim();
}

/** Defensive read of a facet's `valueDescriptions` map. */
function parseValueDescriptions(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = normalizeValue(key);
    const text = String(value ?? '').trim();
    if (name && text) out[name] = text;
  }
  return out;
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

/** Strips the `#` and any list bullet a model glued to a suggestion. */
function cleanSuggestion(raw: string): string {
  return raw
    .trim()
    .replace(/^#/, '')
    .replace(/^[-*+]\s+/, '')
    .trim();
}

/**
 * Shapes a raw suggestion into the canonical `facet/value` form. Covers the
 * shapes models actually send when they drift: `facet: value`, `facet = value`,
 * `facet - value` and a YAML bullet glued to the front (`- facet: value`).
 */
function tagCandidates(raw: string): string[] {
  const cleaned = cleanSuggestion(raw);
  if (!cleaned) return [];
  const pair =
    cleaned.match(/^([^/\s:=]+)\s*[/:=]\s*(.+)$/) ??
    cleaned.match(/^([^/\s:=]+)\s+-\s+(.+)$/);
  if (!pair) return [normalizeTag(cleaned)];
  const value = pair[2].replace(/^[-_\s]+/, '');
  return [normalizeTag(`${pair[1]}/${value}`), normalizeTag(cleaned)];
}

/**
 * Returns the vocabulary tag a suggestion means, or `''` when it means nothing
 * the vocabulary knows.
 *
 * A value with no facet is accepted only when exactly one facet declares it:
 * with two candidates the intent is genuinely ambiguous, and guessing there is
 * exactly how synonyms multiply.
 */
export function resolveTag(raw: string, vocabulary: Vocabulary): string {
  const known = listTags(vocabulary);
  for (const candidate of tagCandidates(raw)) {
    if (candidate && known.includes(candidate)) return candidate;
  }
  const bare = cleanSuggestion(raw);
  if (!/[/:=]/.test(bare)) {
    const value = normalizeValue(bare);
    const owners = known.filter(tag => tag.endsWith(`/${value}`));
    if (owners.length === 1) return owners[0];
  }
  return '';
}

/**
 * Splits proposed tags into the ones the vocabulary knows and the rest.
 *
 * A strict comparison throws away usable work: models often answer `facet:`
 * instead of `facet/`, which leaves every tag unknown even when the choice of
 * value is right. So each suggestion is repaired first (`resolveTag`). The
 * repairs are checked against the vocabulary, which is a closed list, so a
 * malformed suggestion can only ever be *accepted* by landing on a tag that
 * really exists — never by inventing one.
 */
export function validateTags(
  vocabulary: Vocabulary,
  tags: string[],
): { valid: string[]; unknown: string[] } {
  const valid: string[] = [];
  const unknown: string[] = [];
  for (const raw of tags) {
    const tag = resolveTag(raw, vocabulary);
    if (tag) {
      valid.push(tag);
      continue;
    }
    const display = normalizeTag(raw);
    if (display) unknown.push(display);
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
    const description = String((facet as { description?: unknown }).description ?? '').trim();
    const valueDescriptions = parseValueDescriptions(
      (facet as { valueDescriptions?: unknown }).valueDescriptions,
    );
    const existing = out.facets.find(f => f.name === name);
    if (existing) {
      existing.values = [...new Set([...existing.values, ...values])].sort();
      if (description && !existing.description) existing.description = description;
      existing.valueDescriptions = { ...existing.valueDescriptions, ...valueDescriptions };
    } else {
      out.facets.push({
        name,
        ...(description ? { description } : {}),
        values: [...new Set(values)].sort(),
        ...(Object.keys(valueDescriptions).length > 0 ? { valueDescriptions } : {}),
      });
    }
  }
  return out;
}

/**
 * Removes empty facets and duplicate values, in place.
 *
 * Descriptions are pruned to the values that survive, so renaming or dropping a
 * value cannot leave an orphan description behind that would later be attached
 * to a value that merely looks like it.
 */
export function tidyVocabulary(vocabulary: Vocabulary): Vocabulary {
  const cleaned: Facet[] = [];
  for (const facet of vocabulary.facets) {
    const name = normalizeFacetName(facet.name);
    if (!name) continue;
    const values = [...new Set(facet.values.map(normalizeValue).filter(Boolean))].sort();
    if (values.length === 0) continue;
    const description = String(facet.description ?? '').trim();
    const valueDescriptions: Record<string, string> = {};
    for (const value of values) {
      const note = valueDescription(facet, value);
      if (note) valueDescriptions[value] = note;
    }
    const existing = cleaned.find(f => f.name === name);
    if (existing) {
      existing.values = [...new Set([...existing.values, ...values])].sort();
      if (description && !existing.description) existing.description = description;
      existing.valueDescriptions = { ...existing.valueDescriptions, ...valueDescriptions };
      continue;
    }
    cleaned.push({
      name,
      ...(description ? { description } : {}),
      values,
      ...(Object.keys(valueDescriptions).length > 0 ? { valueDescriptions } : {}),
    });
  }
  cleaned.sort((a, b) => a.name.localeCompare(b.name));
  return { facets: cleaned };
}

/**
 * Description of the vocabulary, used inside the prompt.
 *
 * Every tag is spelled out in full, on purpose. A compact listing such as
 * `proyecto: lisa, amawal` reads as if the `key: value` pair *were* the tag, and
 * models then answer `proyecto: lisa` — which no vocabulary lookup can match.
 * Showing the real strings leaves nothing to infer from the separator.
 *
 * The optional `— description` after a facet name and the `(description)` after
 * a value are the owner's own words about what each one means. They are what
 * turns "pick from this list" into "pick the one that matches": without them a
 * model can only reach for the nearest-looking value.
 */
export function vocabularyPrompt(vocabulary: Vocabulary): string {
  const tidy = tidyVocabulary(vocabulary);
  if (tidy.facets.length === 0) return '(no vocabulary defined yet)';
  return tidy.facets
    .map(f => {
      const head = f.description ? `${f.name} — ${f.description}` : f.name;
      const values = f.values
        .map(v => {
          const note = valueDescription(f, v);
          return note ? `${tagFor(f.name, v)} (${note})` : tagFor(f.name, v);
        })
        .join(', ');
      return `- ${head}: ${values}`;
    })
    .join('\n');
}
