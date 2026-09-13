import { App, Modal, Setting } from 'obsidian';
import type VaultLibrarianPlugin from '../main';
import { loadCatalog, type CatalogEntry } from '../catalog';
import {
  PICKER_STATE_LABEL,
  isNoteChanged,
  pickerRow,
  type PickerRow,
  type ProposalsFile,
} from '../proposals';

/** Rows drawn at once; the Find box is what narrows a large vault. */
const MAX_ROWS = 300;

/**
 * Lets the user choose which notes a run visits, instead of trusting a number.
 *
 * The batch size used to be the only lever, and the order is fixed by path, so
 * reaching one note meant processing every note before it. Here the selection is
 * explicit — and it is exactly what the `forcePaths` option of a run expects, so
 * no new machinery is involved.
 */
export class SelectNotesModal extends Modal {
  private entries: CatalogEntry[] = [];
  private file: ProposalsFile | null = null;
  private readonly chosen = new Set<string>();
  private search = '';
  private onlyWork = true;
  /**
   * Whether the notes the plugin has already decided about may be ticked.
   *
   * Off every time the modal opens, and deliberately not a saved setting: it
   * replaces a stored proposal, which is work already done, so it has to be a
   * conscious act each time rather than a state the panel is left in.
   */
  private allowDecided = false;
  private shown: Array<{ entry: CatalogEntry; info: PickerRow }> = [];
  private listEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: VaultLibrarianPlugin,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Vault Librarian — Choose notes');
    const catalog = await loadCatalog(this.app, this.plugin.settings);
    this.entries = catalog?.entries ?? [];
    this.file = await this.plugin.getProposalsFile();
    this.render();
  }

  onClose(): void {
    this.chosen.clear();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (!this.file) return;
    if (this.entries.length === 0) {
      contentEl.createEl('p', {
        text: 'There is no catalogue yet. Run "Scan vault" first, so the notes exist to choose from.',
      });
      return;
    }

    const rows = this.rows();
    const todo = rows.filter(row => row.info.selectable).length;
    contentEl.createEl('p', {
      text:
        `${this.entries.length} notes in the catalogue · ${todo} selectable · ` +
        `${this.file.proposals.filter(p => p.status === 'applied').length} applied.`,
    });
    contentEl.createEl('p', {
      text:
        'Tick the notes you want and press the button at the bottom. The selection is the ' +
        'whole batch: "Max notes per run" does not apply to it.',
      cls: 'vl-hint',
    });
    // One line, not a sentence per row: the explanation belongs here, where it
    // is read once, and the rows keep a short reason that fits on one line — a
    // long one per row made every row a different width.
    const refused = this.entries.length - todo;
    if (refused > 0 && !this.allowDecided) {
      contentEl.createEl('p', {
        text:
          `${refused} note(s) are greyed out: the plugin has already decided about them. ` +
          'Tick the box below to work on them again.',
        cls: 'vl-hint',
      });
    }

    new Setting(contentEl)
      .setName('Find')
      .setDesc('Part of a path or of a title.')
      .addText(text =>
        text.setValue(this.search).onChange(value => {
          this.search = value;
          this.renderList();
        }),
      )
      .addDropdown(dd =>
        dd
          .addOption('work', 'Only notes with work to do')
          .addOption('all', 'All notes')
          .setValue(this.onlyWork ? 'work' : 'all')
          .onChange(value => {
            this.onlyWork = value === 'work';
            this.renderList();
          }),
      )
      .addButton(btn =>
        btn.setButtonText('Select all shown').onClick(() => {
          for (const row of this.shown) {
            if (row.info.selectable) this.chosen.add(row.entry.path);
          }
          this.renderList();
        }),
      )
      .addButton(btn =>
        btn.setButtonText('Clear').onClick(() => {
          this.chosen.clear();
          this.renderList();
        }),
      );

    new Setting(contentEl)
      .setName('Allow notes already decided')
      .setDesc(
        'Accepts and applied notes are refused on purpose: re-asking replaces their stored ' +
          'proposal, which is work already done. With this on they can be ticked again, and ' +
          'the new proposal replaces the old one. An applied note keeps the tags already ' +
          'written in its frontmatter — "Undo last apply" is what takes those out.',
      )
      .addToggle(toggle =>
        toggle.setValue(this.allowDecided).onChange(value => {
          this.allowDecided = value;
          // The whole panel, not just the list: the count above this toggle is
          // part of the answer, and leaving it stale would be the very kind of
          // contradiction that made the two row kinds indistinguishable.
          this.render();
        }),
      );

    this.listEl = contentEl.createDiv({ cls: 'vl-pick-list' });
    this.footerEl = contentEl.createDiv();
    this.renderList();
  }

  private rows(): Array<{ entry: CatalogEntry; info: PickerRow }> {
    const byPath = new Map((this.file?.proposals ?? []).map(p => [p.path, p]));
    return this.entries.map(entry => {
      const proposal = byPath.get(entry.path);
      return {
        entry,
        info: pickerRow(
          proposal,
          proposal ? isNoteChanged(proposal, entry) : false,
          this.allowDecided,
        ),
      };
    });
  }

  private renderList(): void {
    const { listEl, footerEl } = this;
    if (!listEl || !footerEl) return;
    listEl.empty();
    footerEl.empty();

    const needle = this.search.trim().toLowerCase();
    this.shown = this.rows().filter(row => {
      if (this.onlyWork && !row.info.selectable) return false;
      return !needle || row.entry.path.toLowerCase().includes(needle);
    });

    for (const row of this.shown.slice(0, MAX_ROWS)) {
      // The row class and the chip are what tell a row that can be ticked from
      // one that cannot. Relying on the disabled checkbox alone did not: both
      // kinds rendered identically, so the only way to find out was to click.
      const line = listEl.createDiv({
        cls: `vl-pick-row ${row.info.selectable ? 'vl-pick-row--todo' : 'vl-pick-row--done'}`,
      });
      const label = line.createEl('label');
      // The project's Obsidian shim types `createEl` as HTMLElement; the real
      // API returns the tag's element.
      const box = label.createEl('input') as HTMLInputElement;
      box.type = 'checkbox';
      box.checked = this.chosen.has(row.entry.path);
      box.disabled = !row.info.selectable;
      box.addEventListener('change', () => {
        if (box.checked) this.chosen.add(row.entry.path);
        else this.chosen.delete(row.entry.path);
        this.updateFooter();
      });
      label.createEl('span', { text: row.entry.path, cls: 'vl-pick-path' });
      line.createEl('span', { text: row.info.note, cls: 'vl-hint vl-pick-note' });
      // The chip goes last and is the only fixed-width column, so it lines up
      // down the list however long the path and the reason are.
      line.createEl('span', {
        text: PICKER_STATE_LABEL[row.info.state],
        cls: `vl-state-chip vl-state-${row.info.state}`,
      });
    }

    if (this.shown.length > MAX_ROWS) {
      listEl.createEl('p', {
        text: `…and ${this.shown.length - MAX_ROWS} more. Narrow the list with Find.`,
        cls: 'vl-hint',
      });
    }
    if (this.shown.length === 0) listEl.createEl('p', { text: 'Nothing matches.' });

    this.updateFooter();
  }

  private updateFooter(): void {
    const footerEl = this.footerEl;
    if (!footerEl) return;
    footerEl.empty();
    const chosen = this.chosen.size;
    new Setting(footerEl)
      .setName(chosen > 0 ? `${chosen} note(s) selected` : 'No notes selected yet')
      .addButton(btn =>
        btn
          .setButtonText('Propose tags for these notes')
          .setCta()
          .setDisabled(chosen === 0)
          .onClick(() => {
            const paths = [...this.chosen];
            const allowDecided = this.allowDecided;
            this.close();
            void this.plugin.proposeSelected(paths, allowDecided);
          }),
      );
  }
}
