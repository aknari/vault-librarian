import { App, Modal, Setting, ToggleComponent } from 'obsidian';

export interface FolderPickerOptions {
  title: string;
  hint: string;
  /** Folders offered, read from the vault by the caller. */
  folders: string[];
  selected: string[];
  onSave: (folders: string[]) => void | Promise<void>;
}

/**
 * A checkbox list over the vault's own folders.
 *
 * Deliberately not a text box with one folder per line, which is what the other
 * folder settings in this family use: typing a path by hand is how a setting
 * ends up holding `00-scr`, looking perfectly configured and matching nothing.
 * Every row here is a folder that exists, and the list is not filtered by the
 * current selection — otherwise a root could never be added.
 */
export class FolderPickerModal extends Modal {
  private readonly selected: Set<string>;
  private readonly toggles = new Map<string, ToggleComponent>();
  private counter: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly options: FolderPickerOptions,
  ) {
    super(app);
    this.selected = new Set(options.selected);
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.contentEl.createEl('p', { text: this.options.hint, cls: 'vl-hint' });

    // A saved folder that no longer exists in the vault stays listed: dropping it
    // from view would silently rewrite a decision the user took.
    const folders = [...new Set([...this.options.folders, ...this.options.selected])].sort((a, b) =>
      a.localeCompare(b),
    );

    if (folders.length === 0) {
      this.contentEl.createEl('p', { text: 'This vault has no folders to choose from yet.' });
      return;
    }

    this.counter = this.contentEl.createEl('p', { cls: 'vl-hint' });
    const list = this.contentEl.createDiv({ cls: 'vl-folder-list' });
    for (const folder of folders) {
      new Setting(list)
        .setName(folder)
        .setClass('vl-folder-row')
        .addToggle(toggle => {
          this.toggles.set(folder, toggle);
          toggle.setValue(this.selected.has(folder)).onChange(value => {
            if (value) this.selected.add(folder);
            else this.selected.delete(folder);
            this.paint();
          });
        });
    }

    new Setting(this.contentEl)
      .addButton(btn =>
        btn.setButtonText('Select all').onClick(() => {
          for (const folder of folders) {
            this.selected.add(folder);
            this.toggles.get(folder)?.setValue(true);
          }
          this.paint();
        }),
      )
      .addButton(btn =>
        btn.setButtonText('Clear').onClick(() => {
          this.selected.clear();
          for (const toggle of this.toggles.values()) toggle.setValue(false);
          this.paint();
        }),
      );

    new Setting(this.contentEl)
      .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(btn =>
        btn
          .setButtonText('Save')
          .setCta()
          .onClick(async () => {
            const chosen = [...this.selected].sort((a, b) => a.localeCompare(b));
            this.close();
            await this.options.onSave(chosen);
          }),
      );

    this.paint();
  }

  private paint(): void {
    if (!this.counter) return;
    this.counter.setText(
      this.selected.size === 0
        ? 'Nothing selected. Empty means no restriction — see the line above.'
        : `${this.selected.size} folder(s) selected.`,
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
