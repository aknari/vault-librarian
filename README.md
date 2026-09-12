# Vault Librarian

**Author:** [T. Bautista](https://github.com/aknari)

Audit, tag and cross-link an Obsidian vault: a machine-readable catalogue, an editable tag vocabulary, and a review queue for LLM proposals.

Vault Librarian answers a question most vaults never resolve: *what is actually in here?* It scans every note, writes a catalogue and a deterministic audit report, and then lets an LLM **propose** summaries, tags and related notes — which you review and accept **before** anything is written.

## Why it exists

Tagging by hand does not scale, and letting a model rewrite your vault is reckless. This plugin splits the work:

- **Deterministic first.** The catalogue and the audit report need no LLM, cost nothing and are reproducible.
- **The vocabulary is the authority.** Tags are nested (`proyecto/lisa`, `tipo/moc`), so facets cannot bleed into each other and synonyms cannot multiply. The model can only choose from it.
- **Nothing is applied without review.** Proposals land in a queue; accepted ones are written to frontmatter after a backup, and one command undoes the whole run.

## Features

- **Scan vault** — builds `catalog.json` (path, title, folder, tags, summary, links in/out, headings, size, mtime) and writes an audit report: untagged notes, orphans, missing frontmatter, missing headings, duplicate titles, tag frequency and per-folder tables.
- **Broken links, with sources** — each missing target lists the notes that link to it, plus a compact table of breakages *by source folder*, and a deterministic title-similarity suggestion (`did you mean …?`) for the typical rename case. Date-like and numeric targets are never "matched" (a suggestion there would be noise), and template-generated junk (`object Object`, `File`, `Overdue`, images, numbers…) lives in a separate *Template noise* section so it never drowns the real breakages. Link targets are matched case- and Unicode-insensitively, so macOS NFD filenames are not reported as broken.
- **Editable tag vocabulary** — facets with add/rename/remove and value lists, import of the tags already used in the vault, optional LLM suggestion of a starting vocabulary, and a *Tidy* step that normalises values and removes duplicates.
- **Propose tags (LLM)** — per note, asks for a one-line `summary`, 3–6 tags **from the vocabulary** and up to 5 related notes. Batched, resumable and cached by `mtime`, so re-runs are cheap and never re-ask.
- **Review queue** — accept, edit or reject each proposal; unknown tags are flagged and never applied silently.
- **Apply accepted** — writes `summary` and `tags` into frontmatter, snapshotting the originals first. **Undo last apply** restores them.
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
npm run build   # compiles and copies main.js into .obsidian/plugins/vault-librarian/
```

## The pipeline

```
0. Scan       vault ──▶ catalog.json + informe.md        (no LLM, deterministic)
1. Vocabulary facets/values ──▶ vocabulary.json          (your decision; the authority)
2. Propose    note ──▶ summary + tags + related          (LLM, batched, cached by mtime)
3. Review     accept / edit / reject ──▶ proposals.json  (nothing written yet)
4. Apply      proposals ──▶ frontmatter (+ backup)       (undo with one command)
5. MOCs       folder ──▶ _MOC.md                         (kills orphans, builds hubs)
```

## Usage

| Command | What it does |
|---|---|
| `Vault Librarian: Scan vault (catalogue + audit report)` | Catalogue + deterministic report. No API key needed. |
| `Vault Librarian: Edit tag vocabulary` | Facets and values, import from the vault, LLM suggestion. |
| `Vault Librarian: Propose tags (LLM)` | Batch proposals for the notes that need them. |
| `Vault Librarian: Review proposals` | Accept, edit or reject; nothing is written yet. |
| `Vault Librarian: Apply accepted proposals` | Writes frontmatter after a backup. |
| `Vault Librarian: Undo last apply` | Restores the notes from the most recent backup. |
| `Vault Librarian: Generate MOCs` | Creates/updates one MOC per folder. |

All of them are also buttons in **Settings → Vault Librarian**.

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
| Excluded folders | `.obsidian`, `.trash`, `node_modules`, `85-archive`, `80-support/templates` | One folder name per line; matched on any path segment. |
| Max notes per run | `25` | Caps a single *Propose* run, to stay inside rate limits. |
| Max characters per note | `4000` | Characters sent to the model per note (`0` = whole note). |
| When applying tags | `merge` | `merge` keeps existing tags and adds the accepted ones; `replace` sets exactly them. |
| Generate MOCs | on | One MOC per folder with 2+ notes. |
| MOC file name | `_MOC` | Without the `.md` extension. |
| Tag for MOC notes | `moc` | Added to the MOC notes' frontmatter. |

## Files it writes

| Path | Contents |
|---|---|
| `<data folder>/catalog.json` | The catalogue: one entry per note. |
| `<data folder>/vocabulary.json` | Facets and values. |
| `<data folder>/proposals.json` | Proposals and their status (`pending`, `accepted`, `rejected`, `applied`). |
| `<data folder>/backups/*.json` | Snapshot taken before each *Apply* run. |
| `<report path>` | The audit report. |
| `<folder>/_MOC.md` | Generated MOCs. |

## Notes on cost and rate limits

Every note means one request, so a *Propose* run over a large vault takes time. The plugin batches by `maxNotesPerRun`, saves after each note (an interrupted run resumes where it stopped) and skips proposals whose note has not changed. On free tiers, keep `maxNotesPerRun` low and `maxCharactersPerNote` moderate; the plugin honours `retry-after` on HTTP 429.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # pure-core tests (markdown, vocabulary, catalogue)
npm run build       # bundles src/main.ts into .obsidian/plugins/vault-librarian/main.js
```

The pure core (`markdown.ts`, `vocabulary.ts`, `analysis.ts`) has no Obsidian imports, so it is unit-tested in plain Node.

## License

MIT © [T. Bautista](https://github.com/aknari). See [LICENSE](LICENSE).
