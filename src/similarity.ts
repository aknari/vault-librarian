/**
 * Deterministic title matching, used to suggest what a broken link probably
 * meant to point at (typical case: a note that was renamed).
 *
 * Pure module: no Obsidian imports.
 */

export interface Candidate {
  title: string;
  path: string;
}

/** Lowercase, accent-free, punctuation-free form used for comparisons. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Leading ordinals/dates (`08-mi-nota`, `2026-09-01 x`) carry no meaning here. */
function coreForm(normalized: string): string {
  return normalized.replace(/^\d+\s*/, '').trim() || normalized;
}

function bigrams(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length - 1; i++) out.push(value.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient over character bigrams. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of left) counts.set(g, (counts.get(g) ?? 0) + 1);
  let intersection = 0;
  for (const g of right) {
    const remaining = counts.get(g) ?? 0;
    if (remaining > 0) {
      intersection++;
      counts.set(g, remaining - 1);
    }
  }
  return (2 * intersection) / (left.length + right.length);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Best candidate for `target`, or null when nothing is close enough.
 * A high threshold keeps the suggestions trustworthy rather than noisy.
 */
export function suggestMatch(
  target: string,
  candidates: Candidate[],
  minScore = 0.7,
): Candidate | null {
  const normalized = normalizeForMatch(target);
  if (normalized.replace(/\s/g, '').length < 3) return null;
  // Date-like and purely numeric targets (`2024-W51`, `2022-09-22`) would "match"
  // any other date, which is worse than no suggestion at all.
  if (!/[a-z]{3}/.test(normalized)) return null;
  const targetCore = coreForm(normalized);

  let best: Candidate | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const candidateFull = normalizeForMatch(candidate.title);
    if (!candidateFull) continue;
    const candidateCore = coreForm(candidateFull);
    const score = Math.max(
      diceCoefficient(normalized, candidateFull),
      diceCoefficient(targetCore, candidateCore),
      1 - levenshtein(targetCore, candidateCore) / Math.max(targetCore.length, candidateCore.length),
    );
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= minScore ? best : null;
}
