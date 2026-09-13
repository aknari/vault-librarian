import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, type LibrarianSettings } from './settings';
import { clearApiKeys, readApiKey, writeApiKey, type SecretStore } from './secrets';
import { addUnknownTags, emptyVocabulary, parseVocabulary, tidyVocabulary, type Vocabulary } from './vocabulary';
import { renderAudit, scanVault, type Catalog, type CatalogStats } from './catalog';
import {
  loadProposals,
  proposeForEntries,
  saveProposals,
  suggestVocabulary,
  type ProposalsFile,
} from './propose';
import { applyAccepted, generateMocs, undoLastApply } from './apply';
import { readText, writeFileSafe } from './vault-io';
import { LibrarianSettingsTab } from './ui/settings-tab';
import { ProgressModal } from './ui/progress';
import { ReviewModal } from './ui/review-modal';
import { VocabularyModal } from './ui/vocabulary-modal';
import { SelectNotesModal } from './ui/select-notes-modal';

const VOCABULARY_FILE = 'vocabulary.json';

export default class VaultLibrarianPlugin extends Plugin {
  settings: LibrarianSettings = { ...DEFAULT_SETTINGS };
  vocabulary: Vocabulary = emptyVocabulary();

  async onload(): Promise<void> {
    await this.loadSettings();

    // The UI is registered before the vault reads below, for the same reason as
    // in WikiForge: a failure further down must not leave the plugin loaded but
    // invisible (no settings tab, no commands) until it is toggled off and on.
    this.addSettingTab(new LibrarianSettingsTab(this.app, this));
    this.addRibbonIcon('library', 'Vault Librarian', () => void this.openReview());

    this.addCommand({
      id: 'scan-vault',
      name: 'Scan vault (catalogue + audit report)',
      callback: () => void this.runScan(),
    });
    this.addCommand({
      id: 'edit-vocabulary',
      name: 'Edit tag vocabulary',
      callback: () => void this.openVocabulary(),
    });
    this.addCommand({
      id: 'propose-tags',
      name: 'Propose tags (LLM)',
      callback: () => void this.runPropose(),
    });
    this.addCommand({
      id: 'propose-selected-notes',
      name: 'Propose tags for selected notes (choose them)',
      callback: () => this.openSelectNotes(),
    });
    this.addCommand({
      id: 'review-proposals',
      name: 'Review proposals',
      callback: () => void this.openReview(),
    });
    this.addCommand({
      id: 'repropose-current-note',
      name: 'Re-propose tags for the current note (ignore the cache)',
      // Hidden when no note is open, instead of offering an action that can
      // only answer "no note is open".
      checkCallback: checking => {
        if (!this.app.workspace.getActiveFile()) return false;
        if (!checking) void this.reproposeCurrentNote();
        return true;
      },
    });
    this.addCommand({
      id: 'apply-accepted',
      name: 'Apply accepted proposals',
      callback: () => void this.runApply(),
    });
    this.addCommand({
      id: 'undo-last-apply',
      name: 'Undo last apply',
      callback: () => void this.runUndo(),
    });
    this.addCommand({
      id: 'generate-mocs',
      name: 'Generate MOCs',
      callback: () => void this.runMocs(),
    });

    // Awaited, not fire-and-forget: the commands above read the vocabulary, so
    // it must be loaded before the first click can reach them. refreshKeyFlag
    // is awaited for the same reason — fired and forgotten, its key read could
    // resolve *after* the user saved a new key and flip the flag back to false.
    await this.loadVocabularyFile();
    await this.refreshKeyFlag();
  }

  // ---------------------------------------------------------------- settings

  async loadSettings(): Promise<void> {
    this.settings = { ...this.settings, ...((await this.loadData()) as Partial<LibrarianSettings>) };
    // promptVersion is a cache key for proposals.json, not a preference: it
    // describes the prompt this build ships with. Taking it from disk would let
    // a value stored by an older version keep outdated proposals alive, which is
    // precisely what it exists to prevent.
    this.settings.promptVersion = DEFAULT_SETTINGS.promptVersion;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ------------------------------------------------------------------- secrets

  private async secretStore(): Promise<SecretStore | null> {
    const appStorage = this.app.secretStorage;
    if (appStorage) {
      return {
        set: async (id, secret) => {
          appStorage.setSecret(id, secret);
        },
        get: async id => appStorage.getSecret(id) ?? null,
        remove: async id => {
          appStorage.deleteSecret(id);
        },
      };
    }
    if (typeof this.setSecret === 'function' && typeof this.getSecret === 'function') {
      return {
        set: async (id, secret) => {
          await (this.setSecret as (id: string, secret: string) => Promise<void>)(id, secret);
        },
        get: async id =>
          (await (this.getSecret as (id: string) => Promise<string | null>)(id)) ?? null,
      };
    }
    return null;
  }

  async getApiKey(): Promise<string | null> {
    const store = await this.secretStore();
    if (!store) return null;
    return readApiKey(store);
  }

  async setApiKey(value: string): Promise<void> {
    const store = await this.secretStore();
    if (!store) throw new Error('this Obsidian version has no secret-storage API.');
    await writeApiKey(store, value);
    this.settings.apiKeyConfigured = true;
    await this.saveSettings();
  }

  async clearApiKey(): Promise<void> {
    const store = await this.secretStore();
    if (!store) return;
    await clearApiKeys(store);
    this.settings.apiKeyConfigured = false;
    await this.saveSettings();
  }

  private async refreshKeyFlag(): Promise<void> {
    const configured = (await this.getApiKey()) !== null;
    if (configured !== this.settings.apiKeyConfigured) {
      this.settings.apiKeyConfigured = configured;
      await this.saveSettings();
    }
  }

  // --------------------------------------------------------------- vocabulary

  async loadVocabularyFile(): Promise<void> {
    const text = await readText(this.app, `${this.settings.dataFolder}/${VOCABULARY_FILE}`);
    if (!text) {
      this.vocabulary = emptyVocabulary();
      return;
    }
    try {
      this.vocabulary = parseVocabulary(JSON.parse(text));
    } catch {
      this.vocabulary = emptyVocabulary();
    }
  }

  /**
   * Writes the vocabulary as it stands. Deliberately *not* tidied here: a facet
   * the user has just added has no values yet, and tidying drops empty facets,
   * which made "Add facet" look like a dead button. Tidying is an explicit
   * action (the "Tidy" button).
   */
  async saveVocabulary(): Promise<void> {
    await writeFileSafe(
      this.app,
      `${this.settings.dataFolder}/${VOCABULARY_FILE}`,
      JSON.stringify(this.vocabulary, null, 2),
    );
  }

  /** Adds values that came back as unknown, under a catch-all facet. */
  async addTagsToVocabulary(tags: string[]): Promise<number> {
    const added = addUnknownTags(this.vocabulary, tags);
    await this.saveVocabulary();
    return added;
  }

  async suggestVocabulary(tags: Array<{ tag: string; count: number }>): Promise<Vocabulary> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('no API key configured (Settings → Vault Librarian).');
    return suggestVocabulary(this.settings, apiKey, tags);
  }

  // --------------------------------------------------------------- proposals

  async getProposalsFile(): Promise<ProposalsFile> {
    return loadProposals(this.app, this.settings);
  }

  async saveProposalsFile(file: ProposalsFile): Promise<void> {
    await saveProposals(this.app, this.settings, file);
  }

  // ------------------------------------------------------------------- scans

  private async scan(): Promise<{ catalog: Catalog; stats: CatalogStats }> {
    return scanVault(this.app, this.settings);
  }

  async runScan(): Promise<void> {
    const { stats } = await this.scan();
    const report = renderAudit(stats);
    await writeFileSafe(this.app, this.settings.reportPath, report);
    new Notice(
      `Vault Librarian: ${stats.total} notes scanned. ${stats.untagged.length} untagged, ` +
        `${stats.orphans.length} orphans. Report: ${this.settings.reportPath}`,
    );
  }

  openVocabulary(): void {
    new VocabularyModal(this.app, this).open();
  }

  openSelectNotes(): void {
    new SelectNotesModal(this.app, this).open();
  }

  /**
   * Proposes tags for exactly the notes the picker returned.
   *
   * Deliberately the same code path as a normal run (`forcePaths`), so the two
   * cannot drift: the picker only decides *which* notes, never how they are
   * asked about. The batch cap is skipped for a hand-picked list — see
   * `proposeForEntries`.
   *
   * `allowDecided` comes straight from the picker's override toggle and is
   * forwarded untouched: this class never decides on its own to replace a
   * decision the user already took.
   */
  async proposeSelected(paths: string[], allowDecided = false): Promise<void> {
    if (paths.length === 0) return;
    await this.loadVocabularyFile();
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      new Notice('Vault Librarian: no API key configured (Settings → Vault Librarian).');
      return;
    }
    if (this.vocabulary.facets.length === 0) {
      new Notice('Vault Librarian: define the tag vocabulary first.');
      this.openVocabulary();
      return;
    }
    const { catalog } = await this.scan();
    const known = new Set(catalog.entries.map(e => e.path));
    const selection = paths.filter(path => known.has(path));
    if (selection.length === 0) {
      new Notice('Vault Librarian: none of the selected notes is in the catalogue any more.');
      return;
    }
    const modal = new ProgressModal(this.app, 'Propose tags (selection)');
    modal.open();
    try {
      const { summary } = await proposeForEntries(
        this.app,
        this.settings,
        apiKey,
        catalog.entries,
        this.vocabulary,
        { forcePaths: selection, allowDecided },
        (done, total, label) => modal.update(done, total, label),
        () => modal.cancelled,
      );
      modal.close();
      new Notice(
        `Vault Librarian: ${summary.processed} of ${selection.length} selected note(s) proposed, ` +
          `${summary.failed} failed. ${summary.pending} pending review.`,
      );
    } catch (e) {
      modal.close();
      new Notice(`Vault Librarian: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async runPropose(): Promise<void> {
    // Re-read from disk first. The in-memory copy is only loaded at plugin
    // startup, so a vocabulary file created or edited while Obsidian was
    // running would be ignored — and the guard below would refuse to propose
    // against a vocabulary that is in fact on disk.
    await this.loadVocabularyFile();
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      new Notice('Vault Librarian: no API key configured (Settings → Vault Librarian).');
      return;
    }
    if (this.vocabulary.facets.length === 0) {
      new Notice('Vault Librarian: define the tag vocabulary first.');
      this.openVocabulary();
      return;
    }
    const { catalog } = await this.scan();
    const modal = new ProgressModal(this.app, 'Propose tags');
    modal.open();
    try {
      const { summary } = await proposeForEntries(
        this.app,
        this.settings,
        apiKey,
        catalog.entries,
        this.vocabulary,
        {},
        (done, total, label) => modal.update(done, total, label),
        () => modal.cancelled,
      );
      modal.close();
      new Notice(
        `Vault Librarian: ${summary.processed} proposed, ${summary.skipped} left for later, ` +
          `${summary.failed} failed.${summary.flagged > 0 ? ` ${summary.flagged} flagged as out of date.` : ''} ` +
          `${summary.pending} pending review.`,
      );
    } catch (e) {
      modal.close();
      new Notice(`Vault Librarian: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Asks the model again about ONE note, ignoring the up-to-date cache.
   *
   * Returns the fresh proposals file so the review panel can re-render from it,
   * or null when it refused — and in that case it says why, because a silent
   * refusal is indistinguishable from the model refusing to help.
   */
  async reproposeNote(path: string): Promise<ProposalsFile | null> {
    await this.loadVocabularyFile();
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      new Notice('Vault Librarian: no API key configured (Settings → Vault Librarian).');
      return null;
    }
    if (this.vocabulary.facets.length === 0) {
      new Notice('Vault Librarian: define the tag vocabulary first.');
      this.openVocabulary();
      return null;
    }

    const current = await loadProposals(this.app, this.settings);
    const existing = current.proposals.find(p => p.path === path);
    if (existing && (existing.status === 'accepted' || existing.status === 'applied')) {
      new Notice(
        `Vault Librarian: ${path} is already ${existing.status} — reject it first if you want it asked again.`,
      );
      return null;
    }

    // A full scan, for two reasons: it refreshes the note's mtime (which is what
    // the normal run compares against) and it supplies the vault's titles, which
    // the "related" suggestions need.
    const { catalog } = await this.scan();
    if (!catalog.entries.some(e => e.path === path)) {
      new Notice(
        `Vault Librarian: ${path} is not in the catalogue — is it excluded, or inside an ignored folder?`,
      );
      return null;
    }

    const { file, summary } = await proposeForEntries(
      this.app,
      this.settings,
      apiKey,
      catalog.entries,
      this.vocabulary,
      { forcePaths: [path] },
    );
    new Notice(
      summary.processed > 0
        ? `Vault Librarian: re-proposed ${path}. ${summary.pending} pending review.`
        : `Vault Librarian: nothing came back for ${path} (${summary.failed} failed) — check the key and the model.`,
    );
    return file;
  }

  async reproposeCurrentNote(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (!active) {
      new Notice('Vault Librarian: no note is open.');
      return;
    }
    await this.reproposeNote(active.path);
  }

  openReview(): void {
    new ReviewModal(this.app, this).open();
  }

  async runApply(): Promise<void> {
    const file = await this.getProposalsFile();
    const accepted = file.proposals.filter(p => p.status === 'accepted').length;
    if (accepted === 0) {
      new Notice('Vault Librarian: no accepted proposals to apply.');
      return;
    }
    const { applied, backupPath } = await applyAccepted(this.app, this.settings, file);
    new Notice(
      backupPath
        ? `Vault Librarian: ${applied} note(s) updated. Backup: ${backupPath}`
        : `Vault Librarian: ${applied} note(s) updated (no backup needed).`,
    );
  }

  async runUndo(): Promise<void> {
    const { restored, backupPath } = await undoLastApply(this.app, this.settings);
    new Notice(
      restored > 0
        ? `Vault Librarian: ${restored} note(s) restored from ${backupPath}.`
        : 'Vault Librarian: no backup found to restore.',
    );
  }

  async runMocs(): Promise<void> {
    const { catalog } = await this.scan();
    const written = await generateMocs(this.app, this.settings, catalog.entries);
    new Notice(
      written.length > 0
        ? `Vault Librarian: ${written.length} MOC(s) created or updated.`
        : 'Vault Librarian: no folder has 2+ notes yet.',
    );
  }
}
