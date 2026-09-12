# Contributing

Thanks for your interest in Vault Librarian.

## Before a big change

Open an issue first and describe the problem. This plugin has a deliberate design
principle — **deterministic first, LLM second, human approval always** — and changes
that write to notes without review are unlikely to be accepted.

## Setup

```bash
git clone https://github.com/aknari/vault-librarian
cd vault-librarian
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` writes `main.js` into `.obsidian/plugins/vault-librarian/` of the
repository's parent vault, so a test vault works best with this repo inside
`<vault>/80-support/`.

## Ground rules

- The pure core (`src/markdown.ts`, `src/vocabulary.ts`, `src/analysis.ts`) must not
  import `obsidian`: that is what makes it testable in plain Node.
- Add a test in `test/core.test.ts` for any logic you touch.
- Never write to a note without going through the proposal queue, and always take a
  backup before applying.
- Keep the UI strings in English.

## Pull requests

1. Fork the repository and create a feature branch.
2. Keep the diff focused; one topic per PR.
3. Make sure `npm run typecheck` and `npm test` pass.
4. Describe what changed and why, and mention how you tested it in Obsidian.

Please be respectful and constructive in all interactions.
