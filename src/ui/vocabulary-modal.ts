import { App, Modal, Notice, Setting } from 'obsidian';
import type VaultLibrarianPlugin from '../main';
import { normalizeFacetName, normalizeValue, tidyVocabulary, tagCount } from '../vocabulary';
import { loadCatalog } from '../catalog';

export class VocabularyModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: VaultLibrarianPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Vault Librarian — Tag vocabulary');
    this.render();
  }

  onClose(): void {
    // nothing to clean up
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const vocabulary = this.plugin.vocabulary;

    contentEl.createEl('p', {
      text:
        'Tags are nested as facet/value (e.g. proyecto/lisa). Values are lowercased and hyphenated, ' +
        'so synonyms cannot multiply. This vocabulary is the authority: proposals outside it are flagged, never applied.',
    });
    contentEl.createEl('p', {
      text: `${vocabulary.facets.length} facet(s), ${tagCount(vocabulary)} tag(s).`,
      cls: 'vl-hint',
    });

    vocabulary.facets.forEach((facet, index) => {
      new Setting(contentEl)
        .setName('Facet')
        .addText(text =>
          text.setPlaceholder('proyecto').setValue(facet.name).onChange(value => {
            facet.name = normalizeFacetName(value);
          }),
        )
        .addButton(btn =>
          btn.setButtonText('Remove facet').onClick(() => {
            vocabulary.facets.splice(index, 1);
            void this.save().then(() => this.render());
          }),
        );
      new Setting(contentEl)
        .setName('Values (one per line)')
        .addTextArea(area =>
          area
            .setPlaceholder('lisa\namawal\nplasma-devel')
            .setValue(facet.values.join('\n'))
            .onChange(value => {
              facet.values = value
                .split('\n')
                .map(normalizeValue)
                .filter(Boolean);
            }),
        );
    });

    new Setting(contentEl)
      .setName('Add facet')
      .setDesc('A facet groups values of the same kind: proyecto, tipo, estado, materia, tema…')
      .addButton(btn =>
        btn.setButtonText('Add facet').setCta().onClick(() => {
          vocabulary.facets.push({ name: `facet-${vocabulary.facets.length + 1}`, values: [] });
          void this.save().then(() => this.render());
        }),
      );

    new Setting(contentEl)
      .setName('Import existing vault tags')
      .setDesc('Puts every tag already used in the vault into one editable facet, so you can prune it.')
      .addButton(btn =>
        btn.setButtonText('Import from vault').onClick(async () => {
          const catalog = await loadCatalog(this.app, this.plugin.settings);
          if (!catalog) {
            new Notice('Vault Librarian: run "Scan vault" first.');
            return;
          }
          const tags = new Set<string>();
          for (const entry of catalog.entries) for (const tag of entry.tags) tags.add(tag);
          const facet = vocabulary.facets.find(f => f.name === 'importado') ?? {
            name: 'importado',
            values: [] as string[],
          };
          if (!vocabulary.facets.includes(facet)) vocabulary.facets.push(facet);
          const existing = new Set(facet.values);
          for (const tag of tags) {
            const value = normalizeValue(tag);
            if (value && !existing.has(value)) {
              facet.values.push(value);
              existing.add(value);
            }
          }
          facet.values.sort();
          await this.save();
          this.render();
          new Notice(`Vault Librarian: imported ${facet.values.length} tag(s) into facet "importado".`);
        }),
      );

    new Setting(contentEl)
      .setName('Suggest a starting vocabulary (LLM)')
      .setDesc('Asks the model to group your existing tags into facets. The result lands here for you to edit.')
      .addButton(btn =>
        btn.setButtonText('Suggest').onClick(async () => {
          const catalog = await loadCatalog(this.app, this.plugin.settings);
          if (!catalog) {
            new Notice('Vault Librarian: run "Scan vault" first.');
            return;
          }
          const counts = new Map<string, number>();
          for (const entry of catalog.entries) {
            for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
          }
          const tags = [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);
          try {
            const suggested = await this.plugin.suggestVocabulary(tags);
            if (suggested.facets.length === 0) {
              new Notice('Vault Librarian: the model returned no facets.');
              return;
            }
            this.plugin.vocabulary = suggested;
            await this.save();
            this.render();
            new Notice(`Vault Librarian: ${suggested.facets.length} facet(s) proposed. Review them.`);
          } catch (e) {
            new Notice(`Vault Librarian: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );

    new Setting(contentEl)
      .setName('Finish')
      .setDesc('Normalise and dedupe before saving.')
      .addButton(btn =>
        btn.setButtonText('Tidy').onClick(async () => {
          this.plugin.vocabulary = tidyVocabulary(vocabulary);
          await this.save();
          this.render();
        }),
      )
      .addButton(btn =>
        btn.setButtonText('Save & close').setCta().onClick(async () => {
          this.plugin.vocabulary = tidyVocabulary(vocabulary);
          await this.save();
          new Notice(
            `Vault Librarian: vocabulary saved (${tagCount(this.plugin.vocabulary)} tags).`,
          );
          this.close();
        }),
      );
  }

  private async save(): Promise<void> {
    await this.plugin.saveVocabulary();
  }
}
