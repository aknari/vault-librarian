import { App, Modal, Notice, Setting } from 'obsidian';
import type VaultLibrarianPlugin from '../main';
import type { Proposal, ProposalsFile } from '../propose';
import { describeMove, planMove } from '../relocation';
import { normalizeTag, validateTags } from '../vocabulary';

const MAX_SHOWN = 60;

export class ReviewModal extends Modal {
  private file: ProposalsFile | null = null;
  /**
   * Which of the collapsed sections the user had open.
   *
   * `render()` rebuilds the whole body, so without this every click inside a
   * section would fold it shut again — and the sections are where the 30-odd
   * already-decided proposals live.
   */
  private readonly openSections = new Set<string>();

  /**
   * Destinations the move dropdown offers, read once per open so a folder
   * created while the panel was closed is not missing.
   */
  private folders: string[] = [];
  private moveEnabled = false;

  constructor(
    app: App,
    private readonly plugin: VaultLibrarianPlugin,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Vault Librarian — Review proposals');
    // The tags shown here are validated against the vocabulary, so read it from
    // disk instead of trusting the copy loaded at startup.
    await this.plugin.loadVocabularyFile();
    this.moveEnabled = this.plugin.settings.moveEnabled;
    this.folders = this.moveEnabled ? this.plugin.getFolderTargets() : [];
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

    const outOfDate = file.proposals.filter(p => p.status === 'pending' && p.noteChanged).length;
    // A move still to be made covers both cases: a pending suggestion nobody has
    // applied yet, and one that *was* applied but was left in place because the
    // destination was taken. Both are the same thing to the reader.
    const moves = file.proposals.filter(
      p => p.moveTo !== '' && planMove(p.path, p.moveTo) !== null,
    ).length;
    contentEl.createEl('p', {
      text:
        `Pending: ${count('pending')} · accepted: ${count('accepted')} · applied: ${count('applied')} · ` +
        `rejected: ${count('rejected')} (of ${file.proposals.length}).` +
        (outOfDate > 0 ? ` Out of date: ${outOfDate}.` : '') +
        (moves > 0 ? ` Moves to make: ${moves}.` : ''),
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

    // The two decided statuses used to be counted in the header and nowhere
    // else: an `accepted` proposal was invisible, so the only way to unblock its
    // note was to edit proposals.json by hand — and the picker refuses both of
    // these states, which left the note unreachable. Reopening puts a proposal
    // back in the queue a forced run ("Choose notes") can visit.
    const accepted = file.proposals.filter(p => p.status === 'accepted');
    const applied = file.proposals.filter(p => p.status === 'applied');
    if (accepted.length > 0 || applied.length > 0) {
      const decided = contentEl.createDiv({ cls: 'vl-decided' });
      decided.createEl('h4', { text: 'Already decided' });
      decided.createEl('p', {
        cls: 'vl-hint',
        text:
          'Not listed above, because a decision has been taken on them. "Back to pending" ' +
          'returns one to the queue so "Choose notes" can pick it up again.',
      });
      if (accepted.length > 0) {
        this.renderDecided(decided, 'Accepted, not applied yet', accepted, file);
      }
      if (applied.length > 0) {
        this.renderDecided(decided, 'Applied to the note', applied, file);
      }
    }

    new Setting(contentEl).addButton(btn =>
      btn.setButtonText('Save & close').setCta().onClick(async () => {
        await this.plugin.saveProposalsFile(file);
        this.close();
      }),
    );
  }

  /**
   * One collapsed section for a decided status, with the two ways back.
   *
   * `applied` needs the warning: the tags are in the note's frontmatter, and
   * reopening a proposal does not take them out — it only lets the model be
   * asked again, with the old tags still visible in the note it is shown. That
   * is a limitation, not an accident, so the row says so instead of letting the
   * user discover it in the note afterwards.
   */
  private renderDecided(
    parent: HTMLElement,
    title: string,
    proposals: Proposal[],
    file: ProposalsFile,
  ): void {
    // `createEl` is typed as HTMLElement by the project's shim; only the real
    // tag knows about `open`.
    const details = parent.createEl('details', { cls: 'vl-decided-section' }) as HTMLDetailsElement;
    details.createEl('summary', { text: `${title} (${proposals.length})` });
    details.open = this.openSections.has(title);
    details.addEventListener('toggle', () => {
      if (details.open) this.openSections.add(title);
      else this.openSections.delete(title);
    });

    for (const proposal of proposals) {
      const box = details.createDiv({ cls: 'vl-review-item vl-review-decided' });
      const head = box.createDiv({ cls: 'vl-review-head' });
      head.createEl('span', { text: proposal.path, cls: 'vl-review-path' });
      head.createEl('span', {
        text: proposal.status,
        cls: `vl-state-chip vl-state-${proposal.status}`,
      });
      box.createEl('p', {
        cls: 'vl-hint',
        text:
          proposal.tags.length > 0
            ? proposal.tags.join(', ')
            : 'no tags in this proposal — applying it would only write the summary',
      });
      // An accepted proposal can carry a move, and this collapsed section is the
      // last place to notice it before pressing Apply.
      const willMove =
        proposal.status === 'accepted' && proposal.moveTo !== ''
          ? planMove(proposal.path, proposal.moveTo)
          : null;
      if (willMove) {
        box.createEl('p', {
          cls: 'vl-hint',
          text: `Applying it will move the note: ${willMove.from || '(root)'} → ${willMove.to}`,
        });
      }
      if (proposal.status === 'applied') {
        box.createEl('p', {
          cls: 'vl-hint',
          text:
            'The tags are already written in the note: going back to pending unlocks the ' +
            'proposal, it does not remove them. Use "Undo last apply" to restore the notes ' +
            'of the last apply, content included.',
        });
        // The move is the one part of an applied proposal that can have been
        // skipped, and the queue would otherwise say nothing about it.
        if (proposal.moveTo !== '' && planMove(proposal.path, proposal.moveTo) !== null) {
          box.createEl('p', {
            cls: 'vl-hint',
            text:
              `The move to ${proposal.moveTo} was not made: something with that name is` +
              ' already there. Move the note yourself, or edit the proposed folder and apply again.',
          });
        }
      }

      new Setting(box)
        .addButton(btn =>
          btn.setButtonText('Back to pending').onClick(async () => {
            proposal.status = 'pending';
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
        );    }
  }

  private renderProposal(
    parent: HTMLElement,
    proposal: Proposal,
    file: ProposalsFile,
  ): void {
    const box = parent.createDiv({ cls: 'vl-review-item' });
    box.createEl('h4', { text: proposal.path });

    // A flag, not a silent re-ask: the usual reason a note changes on its own is
    // a plugin rewriting its frontmatter on open, and replacing the proposal
    // automatically would throw away whatever was edited here.
    if (proposal.noteChanged) {
      box.createEl('p', {
        cls: 'vl-hint',
        text:
          'The note changed after this proposal was written, so it may be out of date. '
          + 'Nothing is re-asked automatically — press Re-propose to ask again.',
      });
    }

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

    if (this.moveEnabled) this.renderMove(box, proposal);

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
      )
      // Offered for everything but an applied proposal, whose tags are already
      // in the note: there the model cannot be asked again without an undo.
      .addButton(btn => {
        if (proposal.status === 'applied') return;
        btn.setButtonText('Re-propose').onClick(async () => {
          btn.setDisabled(true);
          // Save first: the edits made in this panel live in memory only, and
          // the run reads the proposals file from disk.
          await this.plugin.saveProposalsFile(file);
          const fresh = await this.plugin.reproposeNote(proposal.path);
          if (fresh) {
            this.file = fresh;
            this.render();
          } else {
            btn.setDisabled(false);
          }
        });
      });
  }

  /**
   * The move row: the folder the model suggests, and the dropdown to change it
   * or drop the suggestion.
   *
   * Offered on every pending proposal, not only on the ones the model wanted to
   * move: the row is also how a note gets moved by hand, with the link rewriting
   * that only Obsidian's file manager does.
   */
  private renderMove(box: HTMLElement, proposal: Proposal): void {
    const current = proposal.path.split('/').slice(0, -1).join('/');
    const options = this.folders.filter(folder => folder !== current);
    // What the model proposed, so that choosing a different folder can drop the
    // reason: it explains a folder that is no longer the answer.
    const suggested = proposal.moveTo;

    const describe = (): string => {
      if (proposal.moveTo !== '' && planMove(proposal.path, proposal.moveTo) === null) {
        // The note was moved there by hand after the suggestion was made.
        return 'The note is already in this folder. Choose another one, or leave it.';
      }
      if (proposal.moveTo !== '') {
        return (
          (proposal.moveReason !== '' ? `${proposal.moveReason} ` : 'Suggested by the model. ') +
          'Accepting this moves the note, and Obsidian rewrites the links that point at it.'
        );
      }
      if (proposal.unknownFolder !== '') {
        // Says "cannot move it to" and not "does not exist": the folder may be
        // real and simply excluded from the destinations.
        return `The model suggested "${proposal.unknownFolder}", which is not a folder this plugin can move a note into. Pick one below, or leave it.`;
      }
      return 'Optional: pick a folder and "Apply accepted" moves the note there, rewriting the links that point at it.';
    };

    const setting = new Setting(box).setName('Move').setDesc(describe());
    // Its own line, repainted in place: re-rendering the whole panel on every
    // dropdown change would rebuild 30 cards to move one sentence.
    const pathLine = box.createEl('p', { cls: 'vl-hint' });
    const paint = (): void => {
      pathLine.setText(
        proposal.moveTo === '' ? '' : `→ ${describeMove(proposal.path, proposal.moveTo)}`,
      );
      setting.setDesc(describe());
    };

    setting.addDropdown(dd => {
      dd.addOption('', '— keep where it is —');
      for (const folder of options) dd.addOption(folder, folder);
      // Two folders the plain list cannot offer, and both have to stay visible
      // and droppable instead of silently reading as "keep where it is": one that
      // was renamed or deleted since the proposal was written, and the note's own
      // folder (the note was moved there by hand after the suggestion).
      if (proposal.moveTo !== '' && !options.includes(proposal.moveTo)) {
        const label = this.folders.includes(proposal.moveTo)
          ? `${proposal.moveTo} (already here)`
          : `${proposal.moveTo} (not found)`;
        dd.addOption(proposal.moveTo, label);
      }
      dd.setValue(proposal.moveTo);
      dd.onChange(value => {
        proposal.moveTo = value;
        if (value !== suggested) proposal.moveReason = '';
        paint();
      });
    });

    paint();
  }
}
