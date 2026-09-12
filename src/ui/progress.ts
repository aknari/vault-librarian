import { App, Modal } from 'obsidian';

export class ProgressModal extends Modal {
  cancelled = false;
  private statusEl!: HTMLElement;
  private fillEl!: HTMLElement;

  constructor(
    app: App,
    private readonly heading: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Vault Librarian — ${this.heading}`);
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'Working…' });
    const track = this.contentEl.createDiv({ cls: 'vl-progress-track' });
    this.fillEl = track.createDiv({ cls: 'vl-progress-fill' });
    this.statusEl = this.contentEl.createEl('p', { cls: 'vl-progress-status' });
    const cancel = this.contentEl.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => {
      this.cancelled = true;
      this.close();
    });
  }

  onClose(): void {
    // nothing to clean up
  }

  update(done: number, total: number, label: string): void {
    this.statusEl.setText(label || `${done}/${total}`);
    this.fillEl.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '100%';
  }
}
