/**
 * Tests for the pure core (no Obsidian, no network). Run with: npm test
 */
import assert from 'node:assert/strict';
import {
  basename,
  formatScalar,
  getList,
  inlineTags,
  parseNote,
  serializeNote,
  setValue,
  tagsOf,
  wikilinks,
} from '../src/markdown';
import {
  addUnknownTags,
  emptyVocabulary,
  importValues,
  listTags,
  normalizeTag,
  normalizeValue,
  parseVocabulary,
  tagFor,
  tidyVocabulary,
  validateTags,
  vocabularyPrompt,
} from '../src/vocabulary';
import { buildCatalog, renderAudit, type RawNote } from '../src/analysis';
import {
  diceCoefficient,
  levenshtein,
  normalizeForMatch,
  suggestMatch,
} from '../src/similarity';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --------------------------------------------------------------- markdown

check('frontmatter: reads inline tag arrays', () => {
  const note = parseNote('---\ntags: [lisa, metodo]\ntipo: nota\n---\n# Hola\n');
  assert.deepEqual(tagsOf(note), ['lisa', 'metodo']);
  assert.equal(note.fence, '---');
});

check('frontmatter: reads block tag lists', () => {
  const note = parseNote('---\ntags:\n  - lisa\n  - destilado\n---\nbody');
  assert.deepEqual(tagsOf(note), ['lisa', 'destilado']);
});

check('frontmatter: round-trips simple notes unchanged', () => {
  const source = '---\ntags: [a, b]\ntipo: nota\n---\n\n# Title\n\ntext\n';
  assert.equal(serializeNote(parseNote(source)), source);
});

check('frontmatter: preserves exotic YAML as raw', () => {
  const source = '---\nnested:\n  key: value\n---\nbody';
  const out = serializeNote(parseNote(source));
  assert.equal(out, source);
});

check('frontmatter: setValue creates the block when missing', () => {
  const note = parseNote('# No frontmatter\n');
  setValue(note, 'summary', 'una línea');
  const out = serializeNote(note);
  assert.ok(out.startsWith('---\nsummary: una línea\n---\n'));
  assert.ok(out.includes('# No frontmatter'));
});

check('frontmatter: setValue replaces in place and keeps order', () => {
  const note = parseNote('---\na: 1\ntags: [x]\nb: 2\n---\nbody');
  setValue(note, 'tags', ['x', 'y']);
  const out = serializeNote(note);
  assert.equal(out, '---\na: 1\ntags:\n  - x\n  - y\nb: 2\n---\nbody');
  assert.deepEqual(getList(note, 'tags'), ['x', 'y']);
});

check('tags: inline tags ignore code fences', () => {
  const body = 'texto #uno\n```\n#no-es-etiqueta\n```\nfin #dos\n';
  assert.deepEqual(inlineTags(body), ['uno', 'dos']);
});

check('wikilinks: strips alias and heading, ignores code', () => {
  const body = 'ver [[Nota|alias]] y [[Otra#Sección]]\n```\n[[NoCuenta]]\n```\n';
  assert.deepEqual(wikilinks(body), ['Nota', 'Otra']);
});

check('basename: drops folder and extension', () => {
  assert.equal(basename('00-src/40-work/Materias.md'), 'Materias');
});

check('code: inline spans and indented fences are not links', () => {
  const body = [
    'Usa `[[enlace]]` para conectar conceptos.',
    '  ```yaml',
    '  fuentes: ["[[nombre-archivo-original]]"]',
    '  ```',
    'Y de verdad [[Nota Real]].',
  ].join('\n');
  assert.deepEqual(wikilinks(body), ['Nota Real']);
});

check('code: inline spans are not tags either', () => {
  assert.deepEqual(inlineTags('texto `#no-cuenta` y #si-cuenta'), ['si-cuenta']);
});

check('tags: letters outside Latin-1 are read whole', () => {
  assert.deepEqual(inlineTags('#tamaziɣt'), ['tamaziɣt']);
  assert.deepEqual(inlineTags('glosa #ⵉⵙⵓⴼⴰ y #ⵜⴰⴳⴳⴰⵍⵉⵏ'), ['ⵉⵙⵓⴼⴰ', 'ⵜⴰⴳⴳⴰⵍⵉⵏ']);
  assert.deepEqual(inlineTags('#materia/gestion-proyectos'), ['materia/gestion-proyectos']);
});

check('tags: a tag is not started in the middle of a word (any script)', () => {
  assert.deepEqual(inlineTags('abc#no-es-tag'), []);
  assert.deepEqual(inlineTags('tamaziɣ#no-es-tag'), []);
  assert.deepEqual(inlineTags('#ⵉⵙⵓⴼⴰ#no-es-tag'), ['ⵉⵙⵓⴼⴰ']);
});

check('frontmatter: quotes only the values that would break YAML', () => {
  assert.equal(formatScalar('Frase normal'), 'Frase normal');
  assert.equal(formatScalar('dice "hola"'), 'dice "hola"');
  assert.equal(formatScalar('Lisa: un procesador'), '"Lisa: un procesador"');
  assert.equal(formatScalar('Lisa: dijo "hola"'), '"Lisa: dijo \\"hola\\""');
  assert.equal(formatScalar('- empieza por guion'), '"- empieza por guion"');
  assert.equal(formatScalar('123'), '"123"');
  assert.equal(formatScalar('con # almohadilla'), '"con # almohadilla"');
  assert.equal(formatScalar(''), '""');
});

check('frontmatter: a summary with a colon leaves the note readable', () => {
  const note = parseNote('---\ntags: [daily]\n---\n\n# Hoy\n');
  setValue(note, 'summary', 'Lisa: procesador RISC-V en C++');
  const out = serializeNote(note);
  assert.ok(out.includes('summary: "Lisa: procesador RISC-V en C++"'));
  assert.ok(out.includes('tags: [daily]'));
});

// ------------------------------------------------------------- vocabulary

check('vocabulary: values are normalised', () => {
  assert.equal(normalizeValue('  RISC V '), 'risc-v');
  assert.equal(normalizeTag('#Proyecto/Lisa'), 'proyecto/lisa');
  assert.equal(tagFor('Proyecto', 'Amawal'), 'proyecto/amawal');
});

check('vocabulary: validateTags splits known from unknown', () => {
  const v = { facets: [{ name: 'proyecto', values: ['lisa', 'amawal'] }] };
  const { valid, unknown } = validateTags(v, ['proyecto/lisa', 'proyecto/otro', 'suelto']);
  assert.deepEqual(valid, ['proyecto/lisa']);
  assert.deepEqual(unknown, ['proyecto/otro', 'suelto']);
  assert.deepEqual(listTags(v), ['proyecto/amawal', 'proyecto/lisa']);
});

check('vocabulary: importValues dedupes', () => {
  const v = emptyVocabulary();
  assert.equal(importValues(v, 'tema', ['Uno', 'uno', 'DOS']), 2);
  assert.deepEqual(v.facets[0].values, ['dos', 'uno']);
});

check('vocabulary: addUnknownTags keeps values under their facet', () => {
  const v = { facets: [{ name: 'proyecto', values: ['lisa'] }] };
  const added = addUnknownTags(v, ['proyecto/nuevo', 'risc-v']);
  assert.equal(added, 2);
  assert.deepEqual(v.facets.find(f => f.name === 'proyecto')?.values, ['lisa', 'nuevo']);
  assert.deepEqual(v.facets.find(f => f.name === 'otros')?.values, ['risc-v']);
});

check('vocabulary: tidyVocabulary drops empty facets and duplicates', () => {
  const v = {
    facets: [
      { name: 'Proyecto', values: ['Lisa', 'lisa', ' '] },
      { name: 'vacia', values: [] },
    ],
  };
  const tidy = tidyVocabulary(v);
  assert.deepEqual(tidy.facets, [{ name: 'proyecto', values: ['lisa'] }]);
});

check('vocabulary: parseVocabulary survives garbage', () => {
  assert.deepEqual(parseVocabulary(null).facets, []);
  assert.deepEqual(parseVocabulary({ facets: 'nope' }).facets, []);
  assert.deepEqual(parseVocabulary({ facets: [{ name: 'Tipo', values: ['MOC', 2] }] }).facets, [
    { name: 'tipo', values: ['2', 'moc'] },
  ]);
});

check('vocabulary: prompt lists facets', () => {
  const text = vocabularyPrompt({ facets: [{ name: 'tipo', values: ['moc', 'nota'] }] });
  assert.equal(text, '- tipo: moc, nota');
});

// --------------------------------------------------------------- analysis

function note(path: string, content: string): RawNote {
  return { path, content, mtime: 1000 };
}

check('catalog: counts untagged, orphans and links', () => {
  const { catalog, stats } = buildCatalog([
    note('00-src/a.md', '---\ntags: [lisa]\n---\nver [[b]]\n'),
    note('00-src/b.md', '# B\n\n#lisa\n'),
    note('00-src/c.md', 'sin nada\n'),
  ]);
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.untagged, ['00-src/c.md']);
  // b is linked from a, so it is not an orphan; c has no links at all.
  assert.deepEqual(stats.orphans, ['00-src/c.md']);
  const a = catalog.entries.find(e => e.title === 'a');
  const b = catalog.entries.find(e => e.title === 'b');
  assert.equal(b?.linksIn, 1);
  assert.deepEqual(a?.tags, ['lisa']);
  assert.equal(catalog.entries.find(e => e.title === 'c')?.hasFrontmatter, false);
});

check('catalog: resolves links regardless of Unicode normalisation', () => {
  const nfd = 'Planificacio\u0301n de Tareas Pendientes'; // macOS filename form
  const nfc = 'Planificaci\u00f3n de Tareas Pendientes'; // typical link form
  const { stats } = buildCatalog([
    note(`x/${nfd}.md`, '# ok\n'),
    note('x/nota.md', `[[${nfc}]]\n`),
  ]);
  assert.equal(stats.brokenLinks.length, 0);
  assert.equal(stats.orphans.length, 0);
});

check('catalog: separates broken links from template noise', () => {
  const { stats } = buildCatalog([
    note('a.md', 'ver [[nota-que-no-existe]] y [[object Object]] y [[File]] y [[Overdue]]\n'),
  ]);
  assert.equal(stats.brokenLinks.length, 1);
  assert.equal(stats.brokenLinks[0].target, 'nota-que-no-existe');
  assert.deepEqual(stats.brokenLinks[0].sources, ['a.md']);
  assert.equal(stats.brokenLinks[0].suggested, null);
  assert.equal(stats.noiseLinks.length, 3);
});

check('catalog: broken links count notes once and suggest a renamed target', () => {
  const { stats } = buildCatalog([
    note('x/Planificación de tareas.md', '# Planificación de tareas\n'),
    note('x/nota.md', '[[Planificación de Tareas Pendientes]] y otra vez [[Planificación de Tareas Pendientes]]\n'),
    note('x/otra.md', '[[Planificación de Tareas Pendientes]]\n'),
  ]);
  const entry = stats.brokenLinks.find(b => b.target === 'Planificación de Tareas Pendientes');
  assert.ok(entry, 'the broken target should be listed');
  assert.equal(entry.count, 2, 'two distinct notes, not three occurrences');
  assert.deepEqual(entry.sources, ['x/nota.md', 'x/otra.md']);
  assert.equal(entry.suggested?.title, 'Planificación de tareas');
});

check('catalog: report lists sources and suggestions for broken links', () => {
  const { stats } = buildCatalog([
    note('x/Planificación de tareas.md', 'ok\n'),
    note('x/nota.md', '[[Planificación de Tareas Pendientes]]\n'),
  ]);
  const report = renderAudit(stats);
  assert.ok(report.includes('## Broken links (1)'));
  assert.ok(report.includes('- from: [[x/nota]]'));
  assert.ok(report.includes('did you mean [[x/Planificación de tareas]]?'));
});

// ------------------------------------------------------------- similarity

check('similarity: normalises titles and scores them', () => {
  assert.equal(normalizeForMatch('  Planificación   de Tareas  '), 'planificacion de tareas');
  assert.ok(diceCoefficient('planificacion de tareas pendientes', 'planificacion de tareas') > 0.7);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

check('similarity: suggestMatch picks the closest title and refuses nonsense', () => {
  const candidates = [
    { title: 'Planificación de tareas', path: 'x/planificacion.md' },
    { title: 'Otra cosa', path: 'x/otra.md' },
  ];
  assert.equal(suggestMatch('Planificación de Tareas Pendientes', candidates)?.path, 'x/planificacion.md');
  assert.equal(suggestMatch('plasma-6', candidates), null);
  assert.equal(suggestMatch('a', candidates), null);
});

check('similarity: ignores ordinal prefixes when comparing', () => {
  const candidates = [{ title: '30-lisa-roadmap', path: 'x/roadmap.md' }];
  assert.equal(suggestMatch('Lis Roadmap', candidates)?.path, 'x/roadmap.md');
});

check('similarity: refuses to guess for date-like targets', () => {
  const candidates = [{ title: '2025-09-22', path: 'x/2025-09-22.md' }];
  assert.equal(suggestMatch('2022-09-22', candidates), null);
  assert.equal(suggestMatch('2024-W51', candidates), null);
});

check('catalog: groups broken links by source folder', () => {
  const { stats } = buildCatalog([
    note('a/uno.md', '[[fantasma]]\n'),
    note('a/dos.md', '[[otro-fantasma]]\n'),
    note('b/tres.md', '[[fantasma]]\n'),
  ]);
  assert.deepEqual(stats.brokenByFolder, [
    { folder: 'a', targets: 2, notes: 2 },
    { folder: 'b', targets: 1, notes: 1 },
  ]);
  const report = renderAudit(stats);
  assert.ok(report.includes('## Broken links by folder'));
});

check('catalog: detects duplicate titles and folder rows', () => {
  const { stats } = buildCatalog([
    note('uno/x.md', 'a\n'),
    note('dos/x.md', 'b\n'),
    note('dos/y.md', 'c\n'),
  ]);
  assert.deepEqual(stats.duplicateTitles, [{ title: 'x', paths: ['uno/x.md', 'dos/x.md'] }]);
  assert.deepEqual(stats.folders, [
    { folder: 'dos', notes: 2, untagged: 2, orphans: 2 },
    { folder: 'uno', notes: 1, untagged: 1, orphans: 1 },
  ]);
});

check('catalog: report renders the headline numbers', () => {
  const { stats } = buildCatalog([note('a.md', 'sin etiqueta\n')]);
  const report = renderAudit(stats);
  assert.ok(report.includes('| Notes analysed | 1 |'));
  assert.ok(report.includes('| Without any tag | 1 (100%) |'));
  assert.ok(report.includes('## Untagged notes (1)'));
});

console.log('');
if (failed > 0) {
  console.error(`${failed} of ${passed + failed} checks failed.`);
  process.exit(1);
}
console.log(`${passed}/${passed} core checks passed.`);
