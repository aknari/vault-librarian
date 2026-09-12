import { App, Modal, Notice, Setting } from 'obsidian';
import type VaultLibrarianPlugin from '../main';
import type { Proposal, ProposalsFile } from '../propose';
import { normalizeTag, validateTags } from '../vocabulary';

const MAX_SHOWN = 60;

export class ReviewModal extends Modal {
  private file: ProposalsFile | null = null;

  constructor(
    app: App,
    private readonly plugin: VaultLibrarianPlugin,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Vault Librarian — Review proposals');
    this.file = await this.plugin.getProposalsFile();
    this.render();
  }

  onClose(): void {
    // nothing to clean up
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const file = this.file;

    if (!file) {
      contentEl.createEl('p', { text: 'Loading…' });
      return;
    }

    const count = (status: Proposal['status']): number =>
      file.proposals.filter(p => p.status === status).length;

    contentEl.createEl('p', {
      text:
        `Pending: ${count('pending')} · accepted: ${count('accepted')} · applied: ${count('applied')} · ` +
        `rejected: ${count('rejected')} (of ${file.proposals.length}).`,
    });
    contentEl.createEl('p', {
      text: 'Nothing is written to your notes until you press "Apply accepted".',
      cls: 'vl-hint',
    });

    const unknown = new Set<string>();
    for (const proposal of file.proposals) for (const tag of proposal.unknown) unknown.add(tag);

    new Setting(contentEl)
      .setName('Unknown tags')
      .setDesc(
        unknown.size > 0
          ? `${unknown.size} suggested tag(s) are outside the vocabulary: ${[...unknown].slice(0, 8).join(', ')}${unknown.size > 8 ? '…' : ''}`
          : 'Every suggested tag exists in the vocabulary. Good.',
      )
      .addButton(btn =>
        btn.setButtonText('Add them to the vocabulary').onClick(async () => {
          if (unknown.size === 0) {
            new Notice('Vault Librarian: nothing to add.');
            return;
          }
          const added = await this.plugin.addTagsToVocabulary([...unknown]);
          for (const proposal of file.proposals) {
            proposal.tags = [...new Set([...proposal.tags, ...proposal.unknown])];
            proposal.unknown = [];
          }
          await this.plugin.saveProposalsFile(file);
          this.render();
          new Notice(`Vault Librarian: ${added} tag(s) added to the vocabulary.`);
        }),
      )
      .addButton(btn =>
        btn.setButtonText('Accept all with known tags').onClick(async () => {
          let accepted = 0;
          for (const proposal of file.proposals) {
            if (proposal.status === 'pending' && proposal.unknown.length === 0) {
              proposal.status = 'accepted';
              accepted++;
            }
          }
          await this.plugin.saveProposalsFile(file);
          this.render();
          new Notice(`Vault Librarian: ${accepted} proposal(s) accepted.`);
        }),
      );

    const pending = file.proposals.filter(p => p.status === 'pending');
    for (const proposal of pending.slice(0, MAX_SHOWN)) this.renderProposal(contentEl, proposal, file);
    if (pending.length > MAX_SHOWN) {
      contentEl.createEl('p', {
        text: `…and ${pending.length - MAX_SHOWN} more pending. Review these first.`,
        cls: 'vl-hint',
      });
    }
    if (pending.length === 0) {
      contentEl.createEl('p', { text: 'No pending proposals. Run "Propose tags" when you want more.' });
    }

    new Setting(contentEl).addButton(btn =>
      btn.setButtonText('Save & close').setCta().onClick(async () => {
        await this.plugin.saveProposalsFile(file);
        this.close();
      }),
    );
  }

  private renderProposal(
    parent: HTMLElement,
    proposal: Proposal,
    file: ProposalsFile,
  ): void {
    const box = parent.createDiv({ cls: 'vl-review-item' });
    box.createEl('h4', { text: proposal.path });

    new Setting(box)
      .setName('Summary')
      .addTextArea(area =>
        area.setValue(proposal.summary).onChange(value => {
          proposal.summary = value.trim();
        }),
      );

    new Setting(box)
      .setName('Tags')
      .setDesc(
        proposal.unknown.length > 0
          ? `Outside the vocabulary (won't be applied): ${proposal.unknown.join(', ')}`
          : 'Comma separated. Must exist in the vocabulary.',
      )
      .addText(text =>
        text.setValue(proposal.tags.join(', ')).onChange(value => {
          const { valid, unknown } = validateTags(
            this.plugin.vocabulary,
            value.split(',').map(normalizeTag).filter(Boolean),
          );
          proposal.tags = valid;
          proposal.unknown = unknown;
        }),
      );

    if (proposal.related.length > 0) {
      new Setting(box).setName('Related').setDesc(proposal.related.join(' · '));
    }

    new Setting(box)
      .addButton(btn =>
        btn.setButtonText('Accept').setCta().onClick(async () => {
          proposal.status = 'accepted';
          await this.plugin.saveProposalsFile(file);
          this.render();
        }),
      )
      .addButton(btn =>
        btn.setButtonText('Reject').onClick(async () => {
          proposal.status = 'rejected';
          await this.plugin.saveProposalsFile(file);
          this.render();
        }),
      );
  }
}
