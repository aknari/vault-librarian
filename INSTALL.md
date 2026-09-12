# Installing Vault Librarian

This plugin is not in Obsidian's community plugin list. Install it manually, from a
release, or with [BRAT](#option-3--brat-auto-updates).

## Requirements

- **Obsidian 1.11.4 or newer**, on desktop.
- **An API key only for the language-model steps.** The audit and the vocabulary work
  entirely offline; *Propose tags* and the vocabulary *Suggest* button need a provider
  (Google Gemini, or any OpenAI-compatible API: Groq, OpenRouter, Ollama…).
- **A folder for its own data**, default `80-support/librarian`.

## Option 1 — From a release (recommended)

1. Download these **three** files from the [latest release](../../releases/latest):

   | File | Why |
   |---|---|
   | `main.js` | The plugin itself. |
   | `manifest.json` | Identity, version and minimum Obsidian version. |
   | `styles.css` | Layout of the review panel and the settings tab. |

2. Create the folder `.obsidian/plugins/vault-librarian/` inside your vault and copy all
   three files into it.
3. In Obsidian: **Settings → Community plugins**, make sure *Restricted mode* is off,
   then enable **Vault Librarian** in the *Installed* tab.

## Option 2 — From source

```bash
git clone https://github.com/aknari/vault-librarian
cd vault-librarian
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` writes `main.js` straight into `.obsidian/plugins/vault-librarian/` of
the repository's **parent** vault, so the build assumes the repo lives inside a vault
(for example `<vault>/80-support/vault-librarian/`).

## Option 3 — BRAT (auto-updates)

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then run
**BRAT: Add a beta plugin for testing** and enter `aknari/vault-librarian`.

## Configuration

In **Settings → Vault Librarian**:

| Setting | What it is |
|---|---|
| Provider / Base URL / Model | Which API to call. *Fetch models* fills the model list; *Save & test* stores the key and verifies it. Models that cannot hold a conversation (transcription, speech, embeddings, re-rankers, guard classifiers) are hidden by default, and the hidden families are configurable. |
| API key | Stored in Obsidian's **secret storage** (your system keychain), shared with other plugins. It is never written to `data.json` nor to any file in the vault. |
| Data folder | Where the catalogue, vocabulary, proposals and backups live. Default `80-support/librarian`. |
| Report path | The note that receives the human-readable audit report. |
| Excluded folders | Folder names skipped while scanning, matched at any depth. |
| Max notes per run | How many notes a single *Propose tags* run may send to the model. Each note is one request. |
| Tag mode | `merge` keeps the tags already in a note's frontmatter and adds the accepted ones; `replace` sets exactly what you accepted. |
| MOC options | Whether to generate one map-of-content note per folder, its file name, and the tag it gets. |

## First run: the intended order

1. **Scan vault** — builds the catalogue and writes the audit report. It uses **no API
   key, costs nothing and does not touch your notes**. Start here: the report tells you
   what is untagged, orphaned, or linking nowhere.
2. **Edit vocabulary** — the authority for tags. *Import from vault* brings in the tags
   you already use so you can prune them; *Suggest* asks the model to group them into
   facets. Values are stored as `facet/value`, which is what makes `tag:proyecto` in
   Obsidian's search match every project at once.
3. **Propose tags** — with a small *Max notes per run* (3–5 is a good start). Proposals
   go to `proposals.json`; **your notes are still untouched**.
4. **Review proposals** — accept, edit or reject each one. Tags outside the vocabulary
   are flagged and are never applied silently.
5. **Apply accepted** — writes `summary` and `tags` into the frontmatter, after taking a
   backup. **Undo last apply** reverts the whole run.
6. **Generate MOCs** — one note per folder with two or more notes. This is the step that
   creates new files in your folders; it only rewrites the block between
   `<!-- librarian:moc:start -->` and `<!-- librarian:moc:end -->`, so your own text
   survives.

## What it writes, and where

| Path | What |
|---|---|
| `<data folder>/catalog.json` | The scan result: one entry per note. |
| `<data folder>/vocabulary.json` | Facets and values. |
| `<data folder>/proposals.json` | Proposals and their status (`pending`, `accepted`, `rejected`, `applied`). |
| `<data folder>/backups/*.json` | Snapshot taken before each *Apply* run, used by *Undo last apply*. |
| `<report path>` | The audit report (default `80-support/librarian/informe.md`). |
| `<folder>/_MOC.md` | Generated maps of content, when MOC generation is enabled. |
| Frontmatter of your notes | `summary` and `tags`, **only** after you press *Apply accepted*, and only for accepted proposals. Inline tags in the body of a note are never modified. |

## Updating

Replace `main.js` with the one from the new release. With BRAT, updates are automatic.

## Uninstalling

Disable the plugin, then delete `.obsidian/plugins/vault-librarian/`.

- Everything it generated (`catalog.json`, the report, the vocabulary, the MOCs, the
  backups) stays in your vault; it is plain Markdown and JSON, so delete it by hand if
  you do not want it.
- Tags already applied to notes stay applied. They are ordinary tags.
- The API key stays in your keychain, because Obsidian's secret storage is shared
  between plugins.
