import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultLibrarianPlugin from '../main';
import { listModels } from '../llm';
import { API_KEY_SECRET } from '../secrets';
import { buildModelChoices, modelLabel } from '../models';
import type { Provider } from '../settings';

/** Sentinel in the model dropdown: ask for a name instead of picking one. */
const CUSTOM_MODEL = '__custom__';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Obsidian has no built-in prompt, and the fetched list may not contain the
 * model you want (a brand-new one, or a local name), so this is the escape
 * hatch behind the dropdown's “Write a model name…” option.
 */
class ModelNameModal extends Modal {
  constructor(
    app: App,
    private readonly current: string,
    private readonly onSubmit: (model: string) => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl('h3', { text: 'Model name' });
    this.contentEl.createEl('p', {
      text: 'Type it exactly as the provider expects it (e.g. qwen/qwen3.8-27b, gemini-2.5-flash, llama3.2).',
    });
    const input = this.contentEl.createEl('input') as unknown as HTMLInputElement;
    input.type = 'text';
    input.value = this.current;
    input.style.width = '100%';
    const submit = (): void => {
      const value = input.value.trim();
      if (value === '') {
        new Notice('Vault Librarian: enter a model name.');
        return;
      }
      this.close();
      void this.onSubmit(value);
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    new Setting(this.contentEl)
      .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(btn => btn.setButtonText('Use this model').setCta().onClick(submit));
    setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class LibrarianSettingsTab extends PluginSettingTab {
  /** Key typed but not saved yet; kept across the re-renders of this tab. */
  private pendingKey = '';

  constructor(
    app: App,
    private readonly plugin: VaultLibrarianPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl('p', {
      text: 'Vault Librarian audits the vault without any model, proposes tags taken from your own vocabulary, and writes nothing into your notes until you review and apply the proposals.',
    });

    new Setting(containerEl).setName('LLM provider').setHeading();
    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Google Gemini directly, or any OpenAI-compatible API (Groq, OpenRouter, LM Studio, Ollama…).')
      .addDropdown(dd =>
        dd
          .addOption('openai', 'OpenAI-compatible')
          .addOption('google', 'Google Gemini')
          .setValue(s.provider)
          .onChange(async value => {
            s.provider = value as Provider;
            await this.plugin.saveSettings();
            this.display(); // the fetched model list belongs to one provider
          }),
      );
    // Gemini has one fixed address, so this row only exists when it is needed.
    if (s.provider === 'openai') {
      new Setting(containerEl)
        .setName('Base URL')
        .setDesc('Where the OpenAI-compatible API lives. Default for Groq: https://api.groq.com/openai/v1 — for a local server, http://localhost:11434/v1 (Ollama).')
        .addText(text =>
          text.setPlaceholder('https://api.groq.com/openai/v1').setValue(s.baseUrl).onChange(async value => {
            s.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
        );
    }

    const cache = s.modelCache;
    const fetched = cache !== null && cache.provider === s.provider && cache.baseUrl === s.baseUrl ? cache.models : [];
    const patterns = s.freeTierPatterns;
    const { models: choices, hidden, offered } = buildModelChoices(s.model, fetched, {
      hidePatterns: s.hiddenModelPatterns,
      freePatterns: patterns,
    });
    new Setting(containerEl)
      .setName('Model')
      .setDesc(
        offered > 0
          ? `${offered} chat model(s) offered by the provider${hidden.length > 0 ? `, ${hidden.length} hidden by your patterns` : ''}${s.provider === 'google' ? ', free-tier names first' : ''}. Pick one, or “Write a model name…” if yours is not listed.`
          : 'No model list yet: press “Save & test” on the key below and the list will fill up here.',
      )
      .addDropdown(dd => {
        for (const model of choices) dd.addOption(model, modelLabel(model, patterns, model === s.model));
        dd.addOption(CUSTOM_MODEL, 'Write a model name…');
        dd.setValue(s.model);
        dd.onChange(async value => {
          if (value === CUSTOM_MODEL) {
            new ModelNameModal(this.app, s.model, async model => {
              s.model = model;
              await this.plugin.saveSettings();
              this.display();
            }).open();
            dd.setValue(s.model); // cancelling keeps the current model selected
            return;
          }
          s.model = value;
          await this.plugin.saveSettings();
        });
      })
      .addButton(btn =>
        btn.setButtonText('Fetch models').onClick(async () => {
          const key = await this.plugin.getApiKey();
          if (key === null) {
            new Notice('Vault Librarian: no key stored yet — save one below first.');
            return;
          }
          try {
            const count = await this.fetchAndCacheModels(key);
            new Notice(`Vault Librarian: ${count} model(s) fetched.`);
            this.display();
          } catch (e) {
            new Notice(`Vault Librarian: could not fetch the model list — ${errorMessage(e)}`);
          }
        }),
      );

    // What the provider's metadata cannot tell you. Groq declares the modality
    // of each model, so its Whisper and Orpheus models are already left out of
    // the list above; a guard classifier is text-in/text-out, though, and no
    // field distinguishes it from a chat model. Hence the patterns.
    new Setting(containerEl)
      .setName('Hide models')
      .setDesc('One pattern per line: a model whose name contains one is left out of the list above. A line starting with `!` overrides that and brings it back (e.g. `!safeguard`). Defaults: whisper, tts, orpheus, embed, rerank, guard — none of those can hold a conversation, and not every provider says so. Empty the list to see everything, then press “Fetch models” to redraw the list with the new patterns.')
      .addTextArea(text =>
        text.setValue(s.hiddenModelPatterns.join('\n')).onChange(async value => {
          s.hiddenModelPatterns = value.split('\n').map(x => x.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }),
      );

    // Gemini is the provider that needs the hint: for an OpenAI-compatible API
    // the list is whatever your endpoint serves, free or not.
    if (s.provider === 'google') {
      new Setting(containerEl)
        .setName('Free-tier name patterns')
        .setDesc('Only labels the list above: Google does not say which models are free, so a model whose name contains one of these (one per line) is shown as “free tier”. Default: `flash` minus `!tts` and `!image` — the Pro models left the free tier in April 2026, and a line starting with `!` is an exclusion (it wins over the inclusions), so you can drop the speech and image variants that carry `flash` in their name. Empty the list to stop labelling.')
        .addTextArea(text =>
          text.setValue(s.freeTierPatterns.join('\n')).onChange(async value => {
            s.freeTierPatterns = value.split('\n').map(x => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName('API key')
      .setDesc(
        s.apiKeyConfigured
          ? `A key is stored in Obsidian's secret storage under “${API_KEY_SECRET}”. Type a new one to replace it, or leave the box empty to test the stored one.`
          : `Stored in Obsidian's secret storage (the system keychain, shared by every plugin) under “${API_KEY_SECRET}” — never in data.json nor in any vault file.`,
      )
      .addText(text => {
        // Obsidian's TextComponent has no setType(): its inputEl is a real
        // <input>, so the type is set on the element itself. Calling a method
        // that does not exist here used to break this chain, which is why the
        // buttons of this row (and every row below it) never rendered.
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.inputEl.spellcheck = false;
        text
          .setPlaceholder(s.apiKeyConfigured ? 'Stored — type to replace' : 'Enter API key')
          .setValue(this.pendingKey)
          .onChange(value => {
            this.pendingKey = value;
          });
      })
      .addButton(btn =>
        btn.setButtonText('Save & test').setCta().onClick(async () => {
          const typed = this.pendingKey.trim();
          // Saving and testing are reported apart on purpose: "it did not like
          // the key" and "the key could not be stored" are different problems
          // and only one of them is the provider's fault.
          if (typed !== '') {
            try {
              await this.plugin.setApiKey(typed);
            } catch (e) {
              new Notice(`Vault Librarian: the key could not be stored — ${errorMessage(e)}`);
              this.display();
              return;
            }
          }
          const key = typed !== '' ? typed : await this.plugin.getApiKey();
          if (key === null || key === '') {
            new Notice('Vault Librarian: enter an API key first.');
            return;
          }
          try {
            const count = await this.fetchAndCacheModels(key);
            this.pendingKey = '';
            new Notice(
              typed !== ''
                ? `Vault Librarian: key saved and working — ${count} model(s) available.`
                : `Vault Librarian: the stored key works — ${count} model(s) available.`,
            );
          } catch (e) {
            new Notice(
              `Vault Librarian: the key is stored, but the provider rejected it — ${errorMessage(e)}`,
            );
          }
          this.display();
        }),
      )
      .addButton(btn =>
        btn.setButtonText('Clear').onClick(async () => {
          await this.plugin.clearApiKey();
          this.pendingKey = '';
          new Notice('Vault Librarian: key cleared.');
          this.display();
        }),
      );

    new Setting(containerEl).setName('Scanning and data').setHeading();
    const addPath = (name: string, key: 'dataFolder' | 'reportPath' | 'mocFileName', desc = ''): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText(text =>
          text.setValue(String(s[key])).onChange(async value => {
            s[key] = value.trim();
            await this.plugin.saveSettings();
          }),
        );
    };
    addPath('Data folder', 'dataFolder', 'Catalogue, vocabulary, proposals and backups live here.');
    addPath('Report note', 'reportPath', 'Note that receives the audit report.');
    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('One folder name per line. Matched on any path segment.')
      .addTextArea(text =>
        text.setValue(s.excludedFolders.join('\n')).onChange(async value => {
          s.excludedFolders = value.split('\n').map(x => x.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl).setName('Tags and MOCs').setHeading();
    new Setting(containerEl)
      .setName('When applying tags')
      .setDesc('merge = keep existing tags and add the accepted ones. replace = set exactly the accepted ones.')
      .addDropdown(dd =>
        dd
          .addOption('merge', 'Merge with existing')
          .addOption('replace', 'Replace existing')
          .setValue(s.tagMode)
          .onChange(async value => {
            s.tagMode = value as 'merge' | 'replace';
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Generate MOCs')
      .setDesc('Create one MOC note per folder with 2 or more notes, linking everything inside it.')
      .addToggle(toggle =>
        toggle.setValue(s.mocEnabled).onChange(async value => {
          s.mocEnabled = value;
          await this.plugin.saveSettings();
        }),
      );
    addPath('MOC file name', 'mocFileName', 'Without the .md extension.');
    new Setting(containerEl)
      .setName('Tag for MOC notes')
      .addText(text =>
        text.setPlaceholder('moc').setValue(s.mocTag).onChange(async value => {
          s.mocTag = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Actions').setHeading();
    const action = (name: string, desc: string, label: string, run: () => void | Promise<void>): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addButton(btn =>
          btn.setButtonText(label).onClick(async () => {
            try {
              await run();
            } catch (e) {
              new Notice(`Vault Librarian: ${e instanceof Error ? e.message : String(e)}`);
            }
          }),
        );
    };
    action(
      'Scan vault',
      'Builds the catalogue and writes the audit report. No LLM, no cost. The batch size does not apply: it always reads every note.',
      'Scan',
      () => this.plugin.runScan(),
    );
    action('Tag vocabulary', 'The authority for tags: facets and values, editable.', 'Edit vocabulary', () =>
      this.plugin.openVocabulary(),
    );

    // The two numbers that govern a run sit next to the button they govern,
    // with the size of the batch spelled out: they used to live above, where
    // nothing said which action they applied to.
    new Setting(containerEl).setName('Batch size').setHeading();
    containerEl.createEl('p', {
      cls: 'vl-hint',
      text:
        `A run proposes for ${s.maxNotesPerRun} note(s) at a time, sending up to ` +
        `${s.maxContextChars || 'all'} character(s) of each. Only the runs below that ask the model ` +
        'are affected.',
    });
    new Setting(containerEl)
      .setName('Notes per run')
      .setDesc(
        'How many notes a "Propose tags" run may process in one go (keeps you inside rate ' +
        'limits). A hand-picked selection ignores this: there the selection is the batch.',
      )
      .addText(text =>
        text.setValue(String(s.maxNotesPerRun)).onChange(async value => {
          const n = Number.parseInt(value, 10);
          s.maxNotesPerRun = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 25;
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    new Setting(containerEl)
      .setName('Characters per note')
      .setDesc('How much of each note is sent to the model (0 = the whole note).')
      .addText(text =>
        text.setValue(String(s.maxContextChars)).onChange(async value => {
          const n = Number.parseInt(value, 10);
          s.maxContextChars = Number.isFinite(n) && n >= 0 ? n : 4000;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl).setName('Run the model').setHeading();
    action(
      'Propose tags',
      'Asks the model for a summary, tags and related notes for the next notes in line. Nothing is written yet.',
      'Propose',
      () => this.plugin.runPropose(),
    );
    action(
      'Propose, choosing the notes',
      'Pick the exact notes you want worked on. The selection is the whole batch.',
      'Choose notes',
      () => this.plugin.openSelectNotes(),
    );
    action('Review proposals', 'Accept, edit or reject each proposal.', 'Review', () =>
      this.plugin.openReview(),
    );
    action('Apply accepted', 'Writes accepted proposals to frontmatter, after a backup.', 'Apply', () =>
      this.plugin.runApply(),
    );
    action('Undo last apply', 'Restores the notes from the most recent backup.', 'Undo', () =>
      this.plugin.runUndo(),
    );
    action('Generate MOCs', 'Creates/updates one MOC per folder, preserving your own text.', 'Generate MOCs', () =>
      this.plugin.runMocs(),
    );
  }

  /**
   * Fetches the provider's model list with the given key and caches it for the
   * Model dropdown. One call, two callers: the "Fetch models" button and
   * "Save & test", so the list is never fetched from two places with two
   * different ideas of what was fetched.
   */
  private async fetchAndCacheModels(key: string): Promise<number> {
    const models = await listModels(this.plugin.settings, key);
    this.plugin.settings.modelCache = {
      provider: this.plugin.settings.provider,
      baseUrl: this.plugin.settings.baseUrl,
      models,
    };
    await this.plugin.saveSettings();
    return models.length;
  }
}
