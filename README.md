---
created: 2026-09-11T14:56
updated: 2026-09-18T09:54
---
# Vault Librarian

**Author:** [T. Bautista](https://github.com/aknari)

Audit, tag and cross-link an Obsidian vault: a machine-readable catalogue, an editable tag vocabulary, and a review queue for LLM proposals.

Vault Librarian answers a question most vaults never resolve: *what is actually in here?* It scans every note, writes a catalogue and a deterministic audit report, and then lets an LLM **propose** summaries, tags, related notes and the folder a note belongs in — which you review and accept **before** anything is written or moved.

## Why it exists

Tagging by hand does not scale, and letting a model rewrite your vault is reckless. This plugin splits the work:

- **Deterministic first.** The catalogue and the audit report need no LLM, cost nothing and are reproducible.
- **The vocabulary is the authority.** Tags are nested (`proyecto/lisa`, `tipo/moc`), so facets cannot bleed into each other and synonyms cannot multiply. The model can only choose from it.
- **Nothing is applied without review.** Proposals land in a queue; accepted ones are written to frontmatter after a backup, and one command undoes the whole run.

## Features

- **Scan vault** — builds `catalog.json` (path, title, folder, tags, summary, links in/out, headings, size, mtime) and writes an audit report: untagged notes, orphans, missing frontmatter, missing headings, duplicate titles, tag frequency and per-folder tables.
- **Broken links, with sources** — each missing target lists the notes that link to it, plus a compact table of breakages *by source folder*, and a deterministic title-similarity suggestion (`did you mean …?`) for the typical rename case. Date-like and numeric targets are never "matched" (a suggestion there would be noise), and template-generated junk (`object Object`, `File`, `Overdue`, images, numbers…) lives in a separate *Template noise* section so it never drowns the real breakages. Link targets are matched case- and Unicode-insensitively, so macOS NFD filenames are not reported as broken.
- **Editable tag vocabulary** — facets with add/rename/remove and value lists, import of the tags already used in the vault, optional LLM suggestion of a starting vocabulary, and a *Tidy* step that normalises values and removes duplicates.
- **Propose tags (LLM)** — per note, asks for a one-line `summary`, 1–6 tags **from the vocabulary**, up to 5 related notes and, optionally, the folder the note belongs in. Batched, resumable and cached by `mtime`, so re-runs are cheap and never re-ask.
- **Review queue** — accept, edit or reject each proposal; unknown tags are flagged and never applied silently. Every proposal also carries a **folder dropdown**, so a note can be filed by hand with the same link rewriting a move would get.
- **Move a note (with its links)** — a proposed folder is refused unless it exists in the vault, and applying it moves the note through Obsidian's file manager, so the links pointing at it are rewritten. A destination already holding a file of that name is left alone and reported. Backed up and undoable like the tags.
- **Apply accepted** — writes `summary` and `tags` into frontmatter and carries out the accepted moves, snapshotting the originals first. **Undo last apply** restores them, note by note, moving each note back where it was.
- **Generate MOCs** — one Map of Content per folder with 2+ notes, linking everything inside it (this is what removes orphan notes). Only the block between `<!-- librarian:moc:start -->` and `<!-- librarian:moc:end -->` is rewritten, so your own text survives.
- **Any LLM provider** — Google Gemini (REST) or any OpenAI-compatible endpoint (Groq, OpenRouter, LM Studio, Ollama…), with `temperature: 0` and `retry-after` handling for rate limits.
- **Only models that can chat** — the dropdown is filled from the provider's own list, and two different filters are applied to it. Models the provider says cannot chat are dropped for good (Gemini via `supportedGenerationMethods`, Groq via `output_modalities`, which is what marks its Whisper and speech models); then your editable *Hide models* patterns remove the rest you do not want to see (test classifiers and the like), because a guard model is text-in/text-out and no field distinguishes it. Editing the patterns needs no extra request: they are applied when the list is drawn, and the number hidden is shown next to the dropdown.
- **Secure API key** — kept in the **system keychain** via Obsidian's secret storage; never in `data.json` or any vault file.

  It is stored under the id `vault-librarian-api-key`. Obsidian only accepts ids of lowercase letters, numbers and dashes (`/^[a-z0-9-]+$/`, 64 characters max), which is why the id is not camelCase: an earlier version used `vaultLibrarianApiKey`, Obsidian's `setSecret` refused it with *"Secret ID is invalid"*, and the key was never saved. A key left under that old id is still read on start-up and is moved to the valid one automatically. You can see and edit the stored secret in Obsidian's own **Secret storage** settings.

## Requirements

- Obsidian 1.11.4 or newer (secret storage).
- An API key for the provider you choose (not needed for *Scan vault*, *Edit vocabulary* or *Generate MOCs*).

## Installation

See **[INSTALL.md](INSTALL.md)** for the release, source and BRAT paths, and for what the plugin writes into your vault.

**Manual install (no build needed):**

1. Create the folder `.obsidian/plugins/vault-librarian/` inside your vault.
2. Copy `main.js`, `manifest.json` and `styles.css` from the release into that folder.
3. In Obsidian: **Settings → Community plugins**, make sure Restricted mode is off, and enable **Vault Librarian**.

**From source:**

```bash
npm install
npm run build   # compiles into dist/
npm run deploy  # build, then copy dist/ into .obsidian/plugins/vault-librarian/
```

## The pipeline

```
0. Scan       vault ──▶ catalog.json + informe.md        (no LLM, deterministic)
1. Vocabulary facets, values and meanings ──▶ vocabulary.json   (your decision; the authority)
2. Propose    note ──▶ summary + tags + related + folder (LLM; batched or hand-picked)
3. Review     accept / edit / reject ──▶ proposals.json  (nothing written or moved yet)
4. Apply      proposals ──▶ frontmatter + folder (+ backup)  (undo with one command)
5. MOCs       folder ──▶ _MOC.md                         (every note reachable, hubs built)
```

## The audit report (step 0)

Deterministic and free: what a scan alone can tell you about your own vault.

- **Untagged** — notes no tag reaches.
- **Orphans** — no link in and no link out. The MOC step exists to empty this list.
- **Broken links** — a target that exists nowhere. Genuinely missing, so worth a look.
- **Links outside the scan** — the target *does* exist, in a folder the settings
  exclude. Obsidian resolves those, so they are reported apart instead of being
  counted as broken, which is what made that number impossible to bring to zero.
- **Links to unreadable files** — the file is in a scanned folder but could not
  be read; a dangling symlink is the usual cause. Neither missing nor fine.
- **Template noise** — targets that look generated by templates or queries
  (`[[1]]`, `[[object Object]]`, images), kept out of the broken count.

The report counts the links the generated MOCs create, so running *Generate MOCs*
and scanning again actually moves the orphan figure — it used to stay frozen, and
the step looked as if it had done nothing.

## Usage

| Command | What it does |
|---|---|
| `Vault Librarian: Scan vault (catalogue + audit report)` | Catalogue + deterministic report. No API key needed. |
| `Vault Librarian: Edit tag vocabulary` | Facets and values, import from the vault, LLM suggestion. |
| `Vault Librarian: Propose tags (LLM)` | Batch proposals for the next notes that need them, in path order. |
| `Vault Librarian: Propose tags for selected notes (choose them)` | A checkable list of every catalogued note with its state. The selection **is** the batch. |
| `Vault Librarian: Review proposals` | Accept, edit or reject; nothing is written yet. Each proposal has its own **Re-propose**. The panel also lists the already-decided ones, with **Back to pending** and **Reject**. |
| `Vault Librarian: Re-propose tags for the current note (ignore the cache)` | Asks the model again about the note you have open, cache aside. |
| `Vault Librarian: Apply accepted proposals` | Writes frontmatter and carries out the moves, after a backup. |
| `Vault Librarian: Undo last apply` | Restores the notes from the most recent backup, including moving them back. |
| `Vault Librarian: Generate MOCs` | Creates/updates one MOC per folder. |

All of them are also buttons in **Settings → Vault Librarian**.

### Moving a note

A note that sits in the wrong folder is the one piece of tidying that cannot be
done by hand without a cost: moving the file makes Obsidian rewrite every link
pointing at it. That is why a move is offered here, reviewed like everything
else, and done through the file manager when you apply.

- **Two lists, not one.** *Notes folders* says where your own notes live: only
  those notes are asked which folder they belong in. *Folders a note may be moved
  to* says where a note may go. An **inbox** is the case that separates them — it
  is full of your notes and it is where things are picked up from, not filed
  into — so it can be a source without being a destination. Empty destinations
  fall back to the notes folders; both empty means no restriction at all, which
  is how the feature behaved before these settings existed. Both are chosen from
  a checkbox list of the vault's own folders, not typed in.
- **The model chooses from a list.** The prompt carries the destinations that
  exist (minus the excluded ones) and the answer is matched against them exactly.
  A folder the vault does not have is never a destination: it is shown in the
  panel as *not a folder this plugin can move a note into* and left alone.
- **Answering with the note's own folder is a valid answer** — that is the model
  saying "it is where it belongs", which is why the prompt asks for the folder
  and not for a change.
- **The row is on every proposal**, not only on the ones the model wanted to
  move: pick a folder and *Apply accepted* files the note there.
- **The name never changes.** This is about the folder. Renaming a note is a
  different decision, and every `[[...]]` that spells the old title would break.
- **A taken destination blocks the move**, never the tags: the note keeps them
  and stays where it is, the panel says so on that row, and the notice counts it.
  The same goes for a destination folder that was renamed or deleted after the
  suggestion was made: a move never creates the folder it was told to use.
- **Undo moves it back** and returns the proposal to *accepted*, pointing at the
  folder the note came from. If the vault changed in the meantime — the note is
  no longer at the destination, or something took its old path — that entry is
  left alone and counted rather than written somewhere it never was.

### Choosing which notes to work on

*Propose tags* walks the vault in path order and takes the next *N* notes that
need work, where *N* is the batch size. That is fine for "keep going", but it
offers no way to jump: to reach one note you would process every note before it.

**Choose notes** is the way in. It lists every catalogued note with its state and
lets you tick the ones you want:

| State | Selectable |
|---|---|
| no proposal yet, pending, out of date, rejected | yes |
| accepted (reviewed, not applied) | only with the toggle below |
| applied | only with the toggle below |

The two refused states are shown greyed out, with a state chip and a two-word
reason next to the note, because a checkbox that does nothing is worse than no
checkbox — and a row that looked clickable but was not was worse still. The
selection is handed to the very same run, and the batch size does not apply to
it: a hand-picked list *is* the batch.

**Allow notes already decided** is a toggle under the list, off every time the
panel opens, that lifts the refusal: those notes can then be ticked and asked
again, and the fresh proposal replaces the stored one. It deliberately does not
do two things:

- it never applies to *Propose tags*, the batch run — only to a hand-picked
  list, where the user is looking at the note in question;
- it takes nothing out of any note. An applied note keeps the tags it was given,
  the model will see them when the note is asked about again, and *Undo last
  apply* is what removes them.

Sending a decided proposal back to the queue from *Review proposals* is the
other way in, and the one to use when only one note is in question.

### Sending a decided proposal back to the queue

*Review proposals* used to list only the pending ones, so an `accepted` proposal
was counted in the header and nowhere else: its note could not be picked, and
nothing in the interface could change that. Both decided statuses now sit in
collapsed sections at the bottom of the panel:

- **Back to pending** — the proposal returns to the queue, and *Choose notes*
offers the note again. For an `accepted` proposal that is the whole story,
because nothing was written yet.
- **Reject** — the note is parked, and the picker offers it again the same way.
- For an `applied` proposal the note's frontmatter **keeps the tags it was
given**: reopening unlocks the proposal, it does not take anything out. The
tags written in the note stay visible to the model when the note is asked about
again. Use *Undo last apply* to restore the content of the last apply.

## Tag format

A proposed tag is always `facet/value`, spelled exactly as it appears in the
vocabulary: `proyecto/lisa`, never `lisa` and never `proyecto: lisa`.

Models drift from that shape, so an answer is repaired before it is judged: a
colon or a dash used as the separator, a YAML bullet glued to the front, a
leading `#` and a value with no facet at all are all understood. Repairs are
checked against the vocabulary, which is a **closed list**, so a drifted
suggestion can only ever be accepted by landing on a tag that really exists —
never by inventing one. A value with no facet is accepted only when exactly one
facet declares it; with two candidates the intent is ambiguous and it is left
unresolved.

The vocabulary is the authority, not the model: a tag outside it is shown in red
in *Review* and is never written to a note.

### Telling the model what a tag means

A bare list of values cannot say what each one is for, and a model handed only
the list reaches for the nearest-looking value. That is not hypothetical: `materia`
was applied to notes of a personal project belonging to no subject, and a note
listing Latvian links got `tema/i18n` because nothing said that `i18n` means
internationalisation *of software* — the only word in the whole prompt that
glossed as "languages" was that one.

So a facet, and each of its values, can carry a description in your own words:

- **Meaning** on the facet — `materia — asignaturas que imparto`.
- **A box per value** — `i18n — internacionalización de software`,
  `obsidian — la aplicación en sí`.

Both are passed to the model exactly as written, and both are optional. Nothing
changes if you leave them empty.

### When a proposal is renewed

A note with no proposal gets one. A decision you already took (accepted, applied,
rejected) is never overwritten. A *pending* proposal is regenerated when the
**prompt, the model or the folder option** changed, because then it answers a
question nobody is asking any more — `proposals.json` records all three.

Editing the two folder lists does not re-ask anything either: a pending suggestion
stays in the panel, editable, and a folder that was renamed or deleted since is
shown as *(not found)* and never created back.

A pending proposal whose **note changed** is a different case, and it is *not*
re-asked. The usual reason a note changes on its own is a plugin rewriting its
frontmatter as you open it — a timestamp updater does it every time — and
regenerating then replaces the proposal, throwing away whatever you had edited in
*Review*. So the run marks it **out of date**, *Review* says so on that row, and
renewing it is your call: **Re-propose**.

Disagreeing with a proposal is not the same as the note being finished with, so
**Re-propose** exists: on the open note (command) or on any single row (*Review*
panel) it asks again, ignoring the cache. It refuses only the two states that
hold work already done — *accepted* (reviewed, not applied yet) and *applied*
(the tags are in the note) — and it says so when it refuses. Rejecting a
proposal does **not** take the note out of the system: a rejected note is one of
the states Re-propose is allowed to revisit.

## Configuration

| Setting | Default | Description |
|---|---|---|
| Provider | `openai` | `openai` = any OpenAI-compatible API; `google` = Gemini directly. |
| Base URL | `https://api.groq.com/openai/v1` | Shown only for the OpenAI-compatible provider — Gemini has a fixed address. For local servers: `http://localhost:11434/v1` (Ollama). |
| Model | `qwen/qwen3.8-27b` | Dropdown with the provider's **chat** models (**Fetch models**), free-tier names first and always including the current one; **Write a model name…** for anything not listed. |
| Free-tier name patterns | `flash`, `!tts`, `!image` | Label only, Gemini only: Google does not expose the billing tier, so a model whose name contains one of these (one per line) is shown as *free tier* — the Pro models left the free tier in April 2026. A line starting with `!` is an exclusion and wins over the inclusions. Empty the list to stop labelling. |
| Hide models | `whisper`, `tts`, `orpheus`, `embed`, `rerank`, `guard` | One pattern per line: a model whose name contains one is left out of the dropdown. It covers what the provider's metadata cannot say — a guard classifier is text-in/text-out like any chat model. `!` brings a model back (`!safeguard`). The model you have selected is never hidden. |
| API key | — | Password field + **Save & test** (stores it in the system keychain *and* proves it works by fetching the model list) + **Clear**. The two are reported separately, so "the key could not be stored" never reads as "the provider rejected the key". |
| Data folder | `80-support/librarian` | Catalogue, vocabulary, proposals and backups. |
| Report note | `80-support/librarian/informe.md` | Where the audit report is written. |
| Excluded folders | `.obsidian`, `.trash`, `node_modules`, `85-archive`, `80-support/templates` | One folder name per line, matched on any path segment; a line with a slash names that path and its subtree. Notes inside are not scanned, and the folders are not offered as destinations for a move. |
| Suggest a folder for each note | on | The folder list goes into the prompt and the model may suggest a move. Off = the prompt never mentions folders. Switching it on or off marks the pending notes for a re-ask, because a cached proposal cannot answer about folders it was never asked about. |
| Notes folders | empty | Where your own notes live, chosen from a list of the vault's folders. Only notes inside are asked which folder they belong in. Empty = every scanned note is asked. It does not change what the scan reads — that is still *Excluded folders*. |
| Folders a note may be moved to | empty | The destinations a move is allowed to use, chosen the same way. Empty = the notes folders above; and if those are empty too, every folder the scan does not exclude. Excluded folders and the plugin's own data folder are never offered. |
| Notes per run | `25` | Caps a single *Propose* run, to stay inside rate limits. A hand-picked selection ignores it: there the selection is the batch. |
| Characters per note | `4000` | Characters sent to the model per note (`0` = whole note). |
| When applying tags | `merge` | `merge` keeps existing tags and adds the accepted ones; `replace` sets exactly them. |
| Generate MOCs | on | One MOC per folder with 2+ notes. A note in a smaller folder is listed in the nearest ancestor's MOC, so no note is left unreachable and no MOC links to a file that is never written. |
| MOC file name | `_MOC` | Without the `.md` extension. |
| Tag for MOC notes | `moc` | Added to the MOC notes' frontmatter. |

## Files it writes

| Path | Contents |
|---|---|
| `<data folder>/catalog.json` | The catalogue: one entry per note. |
| `<data folder>/vocabulary.json` | Facets, values, and their optional descriptions. |
| `<data folder>/proposals.json` | Proposals and their status (`pending`, `accepted`, `rejected`, `applied`). |
| `<data folder>/backups/*.json` | Snapshot taken before each *Apply* run, plus where each moved note went. |
| `<report path>` | The audit report. |
| `<folder>/_MOC.md` | Generated MOCs. |

## Notes on cost and rate limits

Every note means one request, so a *Propose* run over a large vault takes time. The plugin batches by *Notes per run* (both numbers sit together, under that heading, in the settings tab: they govern the runs that call the model), saves after each note — so an interrupted run resumes where it stopped — and skips the notes that need no work. On free tiers, keep the batch small and the per-note character limit moderate; the plugin honours `retry-after` on HTTP 429.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # pure-core tests (markdown, vocabulary, catalogue)
npm run build       # bundles src/main.ts and styles.css into dist/
npm run deploy      # build, then copy dist/ into .obsidian/plugins/vault-librarian/
```

The pure core (`markdown.ts`, `vocabulary.ts`, `analysis.ts`) has no Obsidian imports, so it is unit-tested in plain Node.

## License

MIT © [T. Bautista](https://github.com/aknari). See [LICENSE](LICENSE).
