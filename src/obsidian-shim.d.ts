declare interface HTMLElement {
  empty(): void;
  setText(value: string): void;
  createEl(tag: string, options?: { text?: string; cls?: string }): HTMLElement;
  createDiv(options?: { text?: string; cls?: string }): HTMLElement;
}

declare module "obsidian" {
  export interface TFileStat {
    mtime: number;
    ctime: number;
    size: number;
  }

  export class TFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    stat: TFileStat;
  }

  export class TFolder {
    path: string;
  }

  export interface SecretStorage {
    setSecret(id: string, secret: string): void;
    getSecret(id: string): string | null;
    deleteSecret(id: string): boolean;
  }

  export class Vault {
    getAbstractFileByPath(path: string): TFile | TFolder | null;
    getMarkdownFiles(): TFile[];
    getFiles(): TFile[];
    read(file: TFile): Promise<string>;
    cachedRead(file: TFile): Promise<string>;
    modify(file: TFile, content: string): Promise<void>;
    create(path: string, content: string): Promise<TFile>;
    createFolder(path: string): Promise<TFolder>;
    delete(file: TFile): Promise<void>;
    /** Every loaded file and folder; the only way to enumerate folders. */
    getAllLoadedFiles(): Array<TFile | TFolder>;
  }

  /**
   * `vault.rename` moves a file; this one also rewrites the links that point at
   * it, which is the whole reason a move goes through the file manager.
   */
  export class FileManager {
    renameFile(file: TFile, newPath: string): Promise<void>;
  }

  export class Workspace {
    getActiveFile(): TFile | null;
  }

  export class App {
    vault: Vault;
    workspace: Workspace;
    fileManager: FileManager;
    secretStorage?: SecretStorage;
  }

  export class Component {
    app: App;
  }

  export class Plugin {
    app: App;
    addCommand(command: {
      id: string;
      name: string;
      /** Obsidian requires one of the two, hence both optional here. */
      callback?: () => void | Promise<void>;
      /** Returning false hides the command; it runs only when `checking` is false. */
      checkCallback?: (checking: boolean) => boolean;
    }): void;
    addSettingTab(tab: PluginSettingTab): void;
    addRibbonIcon(icon: string, title: string, callback: () => void | Promise<void>): HTMLElement;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    setSecret?(id: string, secret: string): Promise<void>;
    getSecret?(id: string): Promise<string | null>;
  }

  export class PluginSettingTab extends Component {
    constructor(app: App, plugin: Plugin);
    containerEl: HTMLElement;
    display(): void;
  }

  export class Setting {
    constructor(containerEl: HTMLElement);
    setName(name: string): this;
    setDesc(desc: string): this;
    setHeading(): this;
    setClass(cls: string): this;
    addToggle(cb: (c: ToggleComponent) => unknown): this;
    addText(cb: (c: TextComponent) => unknown): this;
    addTextArea(cb: (c: TextAreaComponent) => unknown): this;
    addDropdown(cb: (c: DropdownComponent) => unknown): this;
    addButton(cb: (c: ButtonComponent) => unknown): this;
  }

  export class ToggleComponent {
    setValue(value: boolean): this;
    onChange(cb: (value: boolean) => void | Promise<void>): this;
  }

  export class TextComponent {
    inputEl: HTMLInputElement;
    setValue(value: string): this;
    setPlaceholder(text: string): this;
    onChange(cb: (value: string) => void | Promise<void>): this;
  }

  export class TextAreaComponent {
    inputEl: HTMLTextAreaElement;
    setValue(value: string): this;
    setPlaceholder(text: string): this;
    onChange(cb: (value: string) => void | Promise<void>): this;
  }

  export class DropdownComponent {
    addOption(value: string, display: string): this;
    setValue(value: string): this;
    onChange(cb: (value: string) => void | Promise<void>): this;
  }

  export class ButtonComponent {
    setButtonText(text: string): this;
    setCta(): this;
    setTooltip(text: string): this;
    setDisabled(disabled: boolean): this;
    onClick(cb: () => void | Promise<void>): this;
  }

  export class Modal extends Component {
    constructor(app: App);
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    onOpen(): void;
    onClose(): void;
    open(): void;
    close(): void;
  }

  export class Notice {
    constructor(message: string | DocumentFragment);
  }

  export function requestUrl(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    throw?: boolean;
  }): Promise<{ status: number; json: any; text: string; headers: Record<string, string> }>;

  export function setIcon(parent: HTMLElement, iconId: string): void;

  export class MarkdownRenderer {
    static render(
      app: App,
      markdown: string,
      el: HTMLElement,
      sourcePath: string,
      component: Component,
    ): Promise<void>;
  }
}
