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
  resolveTag,
  tagFor,
  tidyVocabulary,
  validateTags,
  vocabularyPrompt,
  type Vocabulary,
} from '../src/vocabulary';
import { mocPlan } from '../src/moc';
import { buildCatalog, renderAudit, type CatalogEntry, type RawNote } from '../src/analysis';
import {
  PICKER_STATE_LABEL,
  TAG_LIMITS,
  TAG_SUPPORT_RULES,
  TAG_TASK_LINE,
  isNoteChanged,
  pickerRow,
  shouldPropose,
  vocabularySuggestionPrompt,
  withoutSelf,
  type PickerState,
  type Proposal,
} from '../src/proposals';
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

check('vocabulary: prompt spells every tag out in full', () => {
  const text = vocabularyPrompt({ facets: [{ name: 'tipo', values: ['moc', 'nota'] }] });
  // A compact listing ('- tipo: moc, nota') reads as if 'tipo: moc' were the
  // tag, and models then answer exactly that, which no lookup can match.
  assert.equal(text, '- tipo: tipo/moc, tipo/nota');
});

check('proposals: the vocabulary prompt names no language of its own', () => {
  const text = vocabularySuggestionPrompt([{ tag: 'amawal', count: 4 }], 'v4');
  // It used to say "Spanish here if they are Spanish" and to show Spanish facet
  // names and real tags as the example. Both steered every other user — and the
  // facet names it returns are written into the notes as `facet/value`.
  for (const banned of ['Spanish', 'español', 'English', 'proyecto', 'lisa']) {
    assert.ok(!text.includes(banned), `the prompt must not name a language: ${banned}`);
  }
  assert.ok(text.includes('the language the tags below are written in'));
  assert.ok(text.includes('amawal (4)'), 'the listing still carries the tags themselves');
});

check('proposals: the prompt asks for no minimum number of tags', () => {
  // A floor of three made models pad every short note to reach the quota: the
  // same invented tag (`tema/obsidian`) came out of two different models on a
  // note that never mentions Obsidian. Both halves must hold — a free count and
  // the rule that says a short list is fine — or the padding comes back.
  assert.equal(TAG_LIMITS.min, 1);
  assert.ok(TAG_TASK_LINE.includes(`1 to ${TAG_LIMITS.max} tags`));
  assert.ok(!/between \d+ and \d+ tags/.test(TAG_TASK_LINE));
  assert.ok(TAG_SUPPORT_RULES.some(r => r.includes('supported by what the note')));
  assert.ok(TAG_SUPPORT_RULES.some(r => r.includes('Never pad the list')));
});

check('vocabulary: resolveTag repairs the shapes models send', () => {
  const v = {
    facets: [
      { name: 'proyecto', values: ['lisa'] },
      { name: 'materia', values: ['sistemas-digitales'] },
      { name: 'tipo', values: ['referencia'] },
    ],
  };
  const cases: Array<[string, string]> = [
    ['proyecto/lisa', 'proyecto/lisa'],
    ['proyecto: lisa', 'proyecto/lisa'],
    ['materia: -sistemas-digitales', 'materia/sistemas-digitales'],
    ['- tipo: referencia', 'tipo/referencia'],
    ['#proyecto/lisa', 'proyecto/lisa'],
    ['sistemas-digitales', 'materia/sistemas-digitales'],
  ];
  for (const [raw, expected] of cases) assert.equal(resolveTag(raw, v), expected, raw);
  assert.deepEqual(validateTags(v, ['proyecto: lisa', 'sistemas-digitales']), {
    valid: ['proyecto/lisa', 'materia/sistemas-digitales'],
    unknown: [],
  });
});

check('vocabulary: an ambiguous bare value is never guessed', () => {
  const v = {
    facets: [
      { name: 'proyecto', values: ['amawal'] },
      { name: 'tema', values: ['amawal'] },
    ],
  };
  assert.equal(resolveTag('amawal', v), '');
  assert.deepEqual(validateTags(v, ['amawal']), { valid: [], unknown: ['amawal'] });
  assert.equal(resolveTag('inventada', v), '');
});

// -------------------------------------------------------------- proposals

function entryAt(mtime: number): CatalogEntry {
  return { path: 'nota.md', mtime } as CatalogEntry;
}

function pendingProposal(mtime: number): Proposal {
  return {
    path: 'nota.md',
    mtime,
    summary: '',
    tags: [],
    related: [],
    unknown: [],
    status: 'pending',
  };
}

check('proposals: a decision already taken is never revisited', () => {
  for (const status of ['accepted', 'applied', 'rejected'] as const) {
    const decided = { ...pendingProposal(1), status };
    assert.equal(shouldPropose(decided, false), false, status);
    assert.equal(shouldPropose(decided, true), false, `${status} (stale)`);
  }
});

check('proposals: forcing re-asks one note but never discards work already done', () => {
  // The user asking again on purpose is the only way to get a second opinion
  // without editing the note, whose mtime is the signal the cache reads.
  const offer = pendingProposal(1);
  assert.equal(shouldPropose(offer, false, true), true, 'pending, note untouched');
  assert.equal(shouldPropose(offer, false, true), true, 'pending, note changed');
  // A rejected note must be revisitable on purpose: without this, one click in
  // the review panel would take it out of the system for good.
  const rejected = { ...offer, status: 'rejected' as const };
  assert.equal(shouldPropose(rejected, false, true), true);
  // These two hold work: `accepted` is reviewed but not applied yet, `applied`
  // is already written into the note.
  assert.equal(shouldPropose({ ...offer, status: 'accepted' as const }, false, true), false);
  assert.equal(shouldPropose({ ...offer, status: 'applied' as const }, false, true), false);
  // And forcing changes nothing for a note with no proposal at all.
  assert.equal(shouldPropose(undefined, false, true), true);
  // The normal run keeps its old rules: forcing is strictly an addition.
  assert.equal(shouldPropose(offer, false), false);
});

check('proposals: a note is never related to itself', () => {
  // Accents, ordinals and punctuation are irrelevant when matching titles.
  assert.deepEqual(
    withoutSelf(
      ['Varios', '20-internacionalización de plasmoids', 'Notas sobre Lisa'],
      '20-Internacionalizacion de Plasmoids',
    ),
    ['Varios', 'Notas sobre Lisa'],
  );
  assert.deepEqual(withoutSelf(['a', 'b', 'c', 'd', 'e', 'f'], 'otra'), ['a', 'b', 'c', 'd', 'e']);
});

check('proposals: pending is revisited when the prompt or the model changed', () => {
  const offer = pendingProposal(1);
  assert.equal(shouldPropose(undefined, false), true);
  assert.equal(shouldPropose(offer, false), false);
  // A batch that produced nothing usable must not block those notes for ever.
  assert.equal(shouldPropose(offer, true), true);
});

check('proposals: a note that changed on its own is flagged, never re-asked', () => {
  const offer = pendingProposal(1);
  assert.equal(isNoteChanged(offer, entryAt(1)), false);
  assert.equal(isNoteChanged(offer, entryAt(2)), true);
  // This used to be `shouldPropose(offer, entryAt(2), false) === true`, i.e. the
  // model was asked again and its answer *replaced* the pending proposal, so
  // whatever you had edited in the review panel was lost. A frontmatter
  // timestamp plugin moves a note's mtime just by opening it.
  assert.equal(shouldPropose(offer, false), false, 'the note moving alone is not a reason to re-ask');
  // A decided proposal is never flagged: its mtime moved because apply wrote
  // the accepted tags into the note.
  for (const status of ['accepted', 'applied', 'rejected'] as const) {
    assert.equal(isNoteChanged({ ...offer, status }, entryAt(2)), false, status);
  }
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

// ------------------------------------------------------------ vocabulary meaning

check('vocabulary: descriptions tell the model what a value means', () => {
  const vocabulary: Vocabulary = {
    facets: [
      { name: 'materia', description: 'asignaturas que imparto', values: ['sistemas-digitales'] },
      {
        name: 'tema',
        values: ['i18n', 'tamazight'],
        valueDescriptions: { i18n: 'internacionalizacion de software' },
      },
    ],
  };
  const prompt = vocabularyPrompt(vocabulary);
  assert.ok(prompt.includes('- materia — asignaturas que imparto: materia/sistemas-digitales'));
  // The value description is what separates `i18n` from `tamazight`.
  assert.ok(prompt.includes('tema/i18n (internacionalizacion de software)'));
  // A value with no description is still spelled out in full.
  assert.ok(prompt.includes('tema/tamazight'));
  assert.ok(!prompt.includes('tamazight ('));
});

check('vocabulary: descriptions survive a round trip and leave no orphans', () => {
  const parsed = parseVocabulary({
    facets: [
      {
        name: 'tema',
        description: 'tecnologias y asuntos',
        values: ['i18n', 'plasma'],
        valueDescriptions: { i18n: 'software', plasma: 'KDE Plasma', fantasma: 'ya no existe' },
      },
    ],
  });
  assert.equal(parsed.facets[0].description, 'tecnologias y asuntos');
  assert.equal(parsed.facets[0].valueDescriptions?.plasma, 'KDE Plasma');
  // `fantasma` describes a value that is not in the list; tidying drops it,
  // instead of leaving it to attach itself to a value that looks like it later.
  const tidy = tidyVocabulary(parsed);
  assert.deepEqual(tidy.facets[0].valueDescriptions, { i18n: 'software', plasma: 'KDE Plasma' });
  // And a vocabulary with no descriptions at all is unchanged by all this.
  const plain = tidyVocabulary({ facets: [{ name: 'tipo', values: ['log'] }] });
  assert.equal(plain.facets[0].valueDescriptions, undefined);
});

check('proposals: every picker state has a label, and no row is silently refused', () => {
  // The picker draws the label next to the note; an unnamed state would render
  // an empty chip, which is how the two refused rows went unnoticed before.
  const states: PickerState[] = ['new', 'pending', 'out-of-date', 'rejected', 'accepted', 'applied'];
  for (const state of states) assert.ok(PICKER_STATE_LABEL[state]?.length > 0, state);
  for (const status of ['accepted', 'applied'] as const) {
    const row = pickerRow({ ...pendingProposal(1), status }, false);
    assert.equal(row.selectable, false, status);
    assert.ok(row.note.length > 0, `${status} still says why it cannot be ticked`);
  }
});

check('proposals: the picker can be told to allow a decided note, but only there', () => {
  for (const status of ['accepted', 'applied'] as const) {
    const decided = { ...pendingProposal(1), status };
    // The override is what makes them reachable again, and it is passed in by
    // the picker rather than inferred. A batch run never replaces a decision.
    assert.equal(pickerRow(decided, false, true).selectable, true, status);
    assert.equal(shouldPropose(decided, false, true, true), true, status);
    assert.equal(shouldPropose(decided, false, true, false), false, status);
    assert.equal(shouldPropose(decided, false, false, true), false, `${status} in a batch`);
  }

  // The reason sits on one line next to the note: a whole sentence per row is
  // what made every row a different width.
  const rows = [
    pickerRow(undefined, false),
    pickerRow(pendingProposal(1), false),
    pickerRow(pendingProposal(1), true),
    pickerRow({ ...pendingProposal(1), status: 'rejected' }, false),
    pickerRow({ ...pendingProposal(1), status: 'accepted' }, false),
    pickerRow({ ...pendingProposal(1), status: 'applied' }, false),
  ];
  for (const row of rows) {
    assert.ok(row.note.length <= 45, `"${row.note}" is short enough for one line`);
    assert.ok(!row.note.includes('\n'), 'and is a single line');
  }
});

check('proposals: the picker offers exactly what a forced run would accept', () => {
  assert.deepEqual(pickerRow(undefined, false), {
    state: 'new',
    selectable: true,
    note: 'no proposal yet',
  });
  assert.equal(pickerRow(pendingProposal(1), false).state, 'pending');
  const changed = pickerRow(pendingProposal(1), true);
  assert.equal(changed.state, 'out-of-date');
  assert.equal(changed.selectable, true);
  assert.equal(pickerRow({ ...pendingProposal(1), status: 'rejected' }, false).selectable, true);
  // These two hold work already done, so a tick must not turn into a no-op.
  for (const status of ['accepted', 'applied'] as const) {
    const row = pickerRow({ ...pendingProposal(1), status }, false);
    assert.equal(row.selectable, false, status);
    assert.ok(row.note.length > 0, `${status} says why it cannot be chosen`);
  }
});

// -------------------------------------------------------------------- mocs

function mocEntry(path: string): CatalogEntry {
  const parts = path.split('/');
  const title = (parts.pop() ?? '').replace(/\.md$/, '');
  return { path, title, folder: parts.join('/') } as CatalogEntry;
}

check('moc: one-note folders are listed in the parent, not linked as a MOC that never exists', () => {
  const plan = mocPlan(
    [
      mocEntry('00-src/30-dev/30-lisa/uno.md'),
      mocEntry('00-src/30-dev/30-lisa/dos.md'),
      mocEntry('00-src/30-dev/10-misc/solo.md'),
    ],
    '_MOC',
  );
  const byFolder = new Map(plan.map(item => [item.folder, item]));
  // 10-misc holds a single note, so no MOC is written for it...
  assert.equal(byFolder.has('00-src/30-dev/10-misc'), false);
  const parent = byFolder.get('00-src/30-dev');
  assert.ok(parent, 'the parent still gets one');
  // ...so the parent must not point at it...
  assert.ok(!parent.block.includes('10-misc/_MOC'), 'no link to a MOC that is never created');
  // ...but its note has to stay reachable all the same.
  assert.ok(parent.block.includes('[[00-src/30-dev/10-misc/solo|solo]]'));
  // A folder that qualifies is still linked as a MOC, and lists its own notes.
  assert.ok(parent.block.includes('[[00-src/30-dev/30-lisa/_MOC|30-lisa]]'));
  const lisa = byFolder.get('00-src/30-dev/30-lisa');
  // Notes are linked path-first, so a bare title can never pick the wrong note.
  assert.ok(lisa?.block.includes('- [[00-src/30-dev/30-lisa/uno|uno]]'));
  assert.ok(lisa?.block.includes('- [[00-src/30-dev/30-lisa/dos|dos]]'));
});

check('moc: every note ends up reachable, and every MOC link points at a MOC that is written', () => {
  const entries = [mocEntry('a/x.md'), mocEntry('a/b/y.md'), mocEntry('a/b/c/z.md')];
  const plan = mocPlan(entries, '_MOC');
  const text = plan.map(item => item.block).join('\n');
  for (const entry of entries) {
    assert.ok(
      text.includes(`[[${entry.folder}/${entry.title}|`),
      `${entry.path} is linked from somewhere`,
    );
  }
  for (const item of plan) {
    for (const match of item.block.matchAll(/\[\[([^\]|]+)/g)) {
      if (!match[1].endsWith('_MOC')) continue;
      assert.ok(plan.some(p => p.path === `${match[1]}.md`), `${match[1]} is written`);
    }
  }
});

// --------------------------------------------------- links outside the scan

check('catalog: a link the scan could not read is not called a missing target', () => {
  const { stats } = buildCatalog(
    [note('00-src/a.md', 'ver [[2024-02-27]], [[comments]] y [[no existe]]\n')],
    {
      unscanned: [
        { title: '2024-02-27', reason: 'excluded' },
        { title: 'comments', reason: 'unreadable' },
      ],
    },
  );
  // Only the target that really does not exist anywhere is left as broken.
  assert.deepEqual(stats.brokenLinks.map(b => b.target), ['no existe']);
  assert.deepEqual(stats.outsideLinks, [{ target: '2024-02-27', count: 1 }]);
  assert.deepEqual(stats.unreadableLinks, [{ target: 'comments', count: 1 }]);
  const report = renderAudit(stats);
  assert.ok(report.includes('| Links outside the scan | 1 |'));
  assert.ok(report.includes('| Links to unreadable files | 1 |'));
  assert.ok(report.includes('## Links to notes outside the scan (1)'));
  assert.ok(report.includes('## Links to unreadable files (1)'));
});

check('catalog: a MOC is a link source, not a note to catalogue', () => {
  const { catalog, stats } = buildCatalog([
    note('00-src/sola.md', 'sin enlaces\n'),
    { path: '00-src/_MOC.md', content: '- [[sola]]\n', mtime: 1000, role: 'link-source' },
  ]);
  // The MOC is not audited...
  assert.deepEqual(catalog.entries.map(e => e.path), ['00-src/sola.md']);
  assert.equal(stats.total, 1);
  // ...but its link still counts, which is what had the orphan figure frozen.
  assert.equal(catalog.entries[0].linksIn, 1);
  assert.deepEqual(stats.orphans, []);
});

check('catalog: a link to a MOC is a working link, not a missing note', () => {
  const { stats } = buildCatalog([
    note('00-src/30-dev/uno.md', '[[00-src/30-dev/_MOC|30-dev]]\n'),
    note('00-src/30-dev/dos.md', '# dos\n'),
    { path: '00-src/30-dev/_MOC.md', content: '- [[uno]]\n- [[dos]]\n', mtime: 1, role: 'link-source' },
  ]);
  // The MOC is not an entry, so a link to it resolved against nothing and was
  // reported as broken — in every MOC, one per subfolder.
  assert.deepEqual(stats.brokenLinks, []);
  assert.deepEqual(stats.orphans, []);
});

check('catalog: a path-qualified link picks the right note of two with the same title', () => {
  const { catalog, stats } = buildCatalog([
    note('00-src/uno/01-materias.md', '# uno\n'),
    note('00-src/dos/01-materias.md', '# dos\n'),
  ]);
  // By title alone the two collapse onto each other, so one of them always
  // looked like an orphan; the paths tell them apart.
  assert.equal(stats.duplicateTitles.length, 1);
  assert.deepEqual(stats.orphans, ['00-src/uno/01-materias.md', '00-src/dos/01-materias.md']);
  const linked = buildCatalog([
    note('00-src/uno/01-materias.md', '# uno\n'),
    note('00-src/dos/01-materias.md', '# dos\n'),
    { path: '00-src/_MOC.md', content: '- [[00-src/uno/01-materias|01-materias]]\n', mtime: 1, role: 'link-source' },
  ]);
  const uno = linked.catalog.entries.find(e => e.path === '00-src/uno/01-materias.md');
  const dos = linked.catalog.entries.find(e => e.path === '00-src/dos/01-materias.md');
  assert.equal(uno?.linksIn, 1, 'the named one is the one that gets the link');
  assert.equal(dos?.linksIn, 0);
});

console.log('');
if (failed > 0) {
  console.error(`${failed} of ${passed + failed} checks failed.`);
  process.exit(1);
}
console.log(`${passed}/${passed} core checks passed.`);
