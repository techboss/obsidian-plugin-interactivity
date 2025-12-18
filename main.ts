import {
    App,
    Editor,
    MarkdownView,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    normalizePath,
    Platform,
    FileSystemAdapter,
} from 'obsidian';

interface InteractivityPluginSettings {
    shellExec: string;
    shellParams: string;
    executeOnLoad: string;
    notice: boolean;
    decorateMultiline: boolean;
    linesToSuppress: number;
    separatedShells: boolean;
    prependOutput: string;
    enviromentVariables: string;
    executeOnUnload: string;
    regexpCleaner: string;
    shortcuts: string;
    advanced: boolean;
}

const DEFAULT_SETTINGS: InteractivityPluginSettings = {
    shellExec: 'python',
    shellParams: '-iq\n##plugin##py_manager.py\n',
    executeOnLoad: 'openai.api_key = "sk-"\n',
    notice: false,
    decorateMultiline: true,
    linesToSuppress: 1,
    separatedShells: false,
    prependOutput: '>>> ',
    enviromentVariables: 'PYTHONIOENCODING=utf8\n',
    executeOnUnload: 'exit()\n',
    regexpCleaner: '^((>>> )|(\\.\\.\\. ))+',
    shortcuts: '@ -> ##param##\n',
    advanced: false,
};

const __EVAL = (s: string) => (0, eval)(`void (__EVAL = ${__EVAL.toString()}); ${s}`);

export default class InteractivityPlugin extends Plugin {
    settings!: InteractivityPluginSettings;
    allSubprocesses: { [key: string]: any } = {};
    warmupOnly = false;
    modal = false;
    advanced = false;
    byEnter = false;
    processingNote = '';
    statusBarItemEl!: HTMLElement;

    async onload() {
        await this.loadSettings();
        this.advanced = Platform.isMobile ? false : this.settings.advanced;

        this.addSettingTab(new InteractivitySettingTab(this.app, this));

        // Warm up subprocess on any keydown
        this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
            if (!this.modal) {
                this.warmupOnly = true;
                (this.app as any).commands.executeCommandById('interactivity:restart');
                this.warmupOnly = false;
            }

            // Trigger execute on Enter (without Shift)
            if (evt.key === 'Enter' && !evt.shiftKey && this.app.workspace.activeEditor) {
                this.byEnter = true;
                (this.app as any).commands.executeCommandById('interactivity:execute');
                this.byEnter = false;
            }
        });

        // Main execute command
        this.addCommand({
            id: 'execute',
            name: 'Execute shell command',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                const fileKey = this.advanced
                    ? this.settings.separatedShells && view.file
                        ? view.file.path
                        : '*'
                    : 'js';

                if (!this.allSubprocesses[fileKey]) return;

                const cursor = editor.getCursor();
                const currentLine = editor.getCursor().line;

                const routine = (that: InteractivityPlugin) => {
                    const activeEditor = that.app.workspace.activeEditor?.editor;
                    if (!activeEditor) return;

                    let selection = activeEditor.getSelection();
                    let lines = selection.split('\n');
                    let firstLine = lines[0] ?? '';

                    // --- Multi-line shortcut detection & parameter building ---
                    let command = '';
                    let matchedShortcutLen = 0;

                    for (const shortcutDef of that.settings.shortcuts.split('\n')) {
                        if (!shortcutDef.trim()) continue;

                        const match = shortcutDef.match(/(.*?)\s*->\s*(.*)/);
                        if (!match) continue;

                        const trigger = match[1];
                        const template = match[2];

                        if (firstLine.startsWith(trigger) && trigger.length > matchedShortcutLen) {
                            matchedShortcutLen = trigger.length;

                            // Extract parameter: everything after trigger, across all lines
                            let paramLines: string[] = [];
                            const firstLineRemainder = firstLine.slice(trigger.length).trimStart();
                            if (firstLineRemainder) paramLines.push(firstLineRemainder);
                            paramLines.push(...lines.slice(1));

                            let param = paramLines.join('\n').trim();
                            param = param.replace(/^\n+|\n+$/g, ''); // Trim leading/trailing blank lines
                            param = param.replace(/"""/g, '\\"""'); // Escape internal triple quotes

                            const useRaw = template.includes('r##param##');
                            const quotedParam = (useRaw ? 'r' : '') + '"""' + param + '"""';

                            command = template
                                .replace(/##param##/g, quotedParam)
                                .replace(/r##param##/g, quotedParam);

                            selection = command;
                        }
                    }

                    // Fallback: no shortcut → send raw selection
                    if (!command) {
                        selection = lines.join('\n');
                    }

                    // Move cursor to end of current line
                    activeEditor.setCursor({ line: currentLine, ch: activeEditor.getLine(currentLine).length });

                    // Execute
                    if (selection.trim()) {
                        if (that.advanced) {
                            that.allSubprocesses[fileKey].stdin.write(selection + '\n');
                        } else {
                            let output: any;
                            try {
                                output = __EVAL(selection);
                            } catch (e) {
                                output = e;
                            }
                            if (output !== undefined && that.processingNote === that.app.workspace.getActiveFile()?.path) {
                                that.insertText(activeEditor, output.toString(), that.settings.decorateMultiline, that.settings.prependOutput, that.settings.notice);
                                that.statusBarItemEl.setText('');
                            }
                        }
                    }
                };

                this.processingNote = this.app.workspace.getActiveFile()?.path ?? '';
                this.statusBarItemEl.setText('Interactivity is busy⏳');

                if (this.byEnter) {
                    // Handle legacy Enter-trigger (single-line shortcut on previous line)
                    const lineIdx = cursor.line - 1;
                    const lineText = editor.getLine(lineIdx);
                    let hasMatch = false;

                    for (const def of this.settings.shortcuts.split('\n')) {
                        const m = def.match(/(.*?)\s*->\s*(.*)/);
                        if (m && lineText.startsWith(m[1])) {
                            hasMatch = true;
                            break;
                        }
                    }

                    if (!hasMatch) return;

                    if (Platform.isMobile) {
                        setTimeout(() => {
                            routine(this);
                        }, 0);
                    } else {
                        editor.replaceRange('', { line: lineIdx, ch: 0 }, { line: cursor.line, ch: cursor.ch });
                        editor.setCursor({ line: lineIdx, ch: 0 });
                        routine(this);
                    }
                } else {
                    routine(this);
                }
            },
        });

        // Restart command
        this.addCommand({
            id: 'restart',
            name: 'Restart Shell',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                if (!this.warmupOnly) {
                    const fileKey = this.advanced
                        ? this.settings.separatedShells && view.file
                            ? view.file.path
                            : '*'
                        : 'js';

                    const proc = this.allSubprocesses[fileKey];
                    if (proc && this.advanced) {
                        try {
                            if (this.settings.executeOnUnload) {
                                proc.stdin.write(this.settings.executeOnUnload + '\n');
                            }
                            proc.kill();
                        } catch (e) {}
                        delete this.allSubprocesses[fileKey];
                    }
                }

                setTimeout(() => this.warmup(editor, view), this.warmupOnly ? 0 : 350);
            },
        });

        // Ribbon icon & status bar
        this.addRibbonIcon('activity', 'Run Interactivity', () => {
            (this.app as any).commands.executeCommandById('interactivity:execute');
            this.app.workspace.activeEditor?.editor?.focus();
        });

        this.statusBarItemEl = this.addStatusBarItem();
        this.statusBarItemEl.setText('');

        // Initial warmup
        this.warmupOnly = true;
        (this.app as any).commands.executeCommandById('interactivity:restart');
        this.warmupOnly = false;
    }

    onunload() {
        Object.values(this.allSubprocesses).forEach((proc) => {
            if (proc && this.advanced) {
                try {
                    if (this.settings.executeOnUnload) proc.stdin.write(this.settings.executeOnUnload + '\n');
                    proc.kill();
                } catch (e) {}
            }
        });
        this.allSubprocesses = {};
    }

    private warmup(editor: Editor, view: MarkdownView) {
        const fileKey = this.advanced
            ? this.settings.separatedShells && view.file
                ? view.file.path
                : '*'
            : 'js';

        if (this.allSubprocesses[fileKey]) return;

        if (this.advanced) {
            const cp = require('child_process');
            if (!cp) {
                new Notice('Unable to run subprocess');
                return;
            }

            const basePath = this.app.vault.adapter instanceof FileSystemAdapter
                ? (this.app.vault.adapter as FileSystemAdapter).getBasePath()
                : '';
            const pluginDir = normalizePath(basePath + '/' + this.manifest.dir + '/1').replace(/\/$/, '');

            const params = this.settings.shellParams
                ? this.settings.shellParams.replace(/##plugin##/g, pluginDir).split('\n')
                : [];

            const env: { [key: string]: string } = {};
            this.settings.enviromentVariables.replace(/##plugin##/g, pluginDir).split('\n').forEach((line) => {
                const [key, ...val] = line.split('=');
                if (key && val.length) env[key] = val.join('=');
            });

            const proc = cp.spawn(this.settings.shellExec.replace(/##plugin##/g, pluginDir), params, { env });
            proc.stdin.setEncoding('utf-8');
            proc.stdout.setEncoding('utf-8');
            proc.stderr.setEncoding('utf-8');

            if (this.settings.executeOnLoad) {
                proc.stdin.write(this.settings.executeOnLoad + '\n');
            }

            let omitted = 0;
            const processOutput = (data: string) => {
                if (omitted < this.settings.linesToSuppress) {
                    omitted++;
                    return;
                }
                data = data.replace(new RegExp(this.settings.regexpCleaner, 'mg'), '');
                if (data && this.processingNote === this.app.workspace.getActiveFile()?.path) {
                    const ed = this.app.workspace.activeEditor?.editor;
                    if (ed) {
                        this.insertText(ed, data, this.settings.decorateMultiline, this.settings.prependOutput, this.settings.notice);
                    }
                    this.statusBarItemEl.setText('');
                }
            };

            proc.stdout.on('data', processOutput);
            proc.stderr.on('data', processOutput);

            this.allSubprocesses[fileKey] = proc;
        } else {
            this.allSubprocesses[fileKey] = true;
        }
    }

    private insertText(
        editor: Editor,
        data: string,
        decorateMultiline: boolean,
        prependOutput: string,
        toNotice: boolean
    ) {
        if (toNotice) {
            new Notice(data);
            return;
        }

        data = data.replace(/\r/g, '');
        if (decorateMultiline) {
            data = data.replace(/(^|[^\\])\n(?!\n*$)/g, `$1\n${prependOutput}`);
        }

        const lines = data.split('\n').length;
        editor.replaceRange('\n' + prependOutput + data.replace(/\n$/g, ''), editor.getCursor());
        editor.setCursor({
            line: editor.getCursor().line + lines,
            ch: editor.getLine(editor.getCursor().line + lines).length,
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.onunload(); // Clean up old processes on settings change
    }

    async saveSettings() {
        this.advanced = Platform.isMobile ? false : this.settings.advanced;
        await this.saveData(this.settings);
    }
}

class InteractivitySettingTab extends PluginSettingTab {
    plugin: InteractivityPlugin;

    constructor(app: App, plugin: InteractivityPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    hide(): void {
        this.plugin.modal = false;
    }

    display(): void {
        this.plugin.modal = true;
        const { containerEl } = this;
        containerEl.empty();

        // Basic settings (unchanged)
        new Setting(containerEl)
            .setName('Use notifications instead of appending the output')
            .addToggle((t) => t.setValue(this.plugin.settings.notice).onChange((v) => {
                this.plugin.settings.notice = v;
                this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Decorate output')
            .setDesc('Prepend the output with custom text')
            .addText((t) => t.setValue(this.plugin.settings.prependOutput).onChange((v) => {
                this.plugin.settings.prependOutput = v;
                this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Decorate each line of the output')
            .addToggle((t) => t.setValue(this.plugin.settings.decorateMultiline).onChange((v) => {
                this.plugin.settings.decorateMultiline = v;
                this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Text shortcuts')
            .setDesc('Format: trigger -> command(##param##) or command(r##param##) for raw strings. One per line.')
            .addTextArea((t) => t
                .setValue(this.plugin.settings.shortcuts)
                .onChange((v) => {
                    this.plugin.settings.shortcuts = v;
                    this.plugin.saveSettings();
                }));

        if (Platform.isMobile) return;

        // Advanced toggle and settings (unchanged structure)
        const advancedToggle = new Setting(containerEl)
            .setName('Advanced options')
            .setDesc('Use external executables instead of JavaScript (unsafe!)')
            .addToggle((t) => t
                .setValue(this.plugin.settings.advanced)
                .onChange(async (v) => {
                    this.plugin.settings.advanced = v;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // Define advanced settings here (same as original)
        const advancedSettings = [
            ['Shell executable path', 'shellExec', 'text'],
            ['Environment variables', 'enviromentVariables', 'textarea'],
            ['Shell CLI arguments', 'shellParams', 'textarea'],
            ['Commands on load', 'executeOnLoad', 'textarea'],
            ['Commands on unload', 'executeOnUnload', 'textarea'],
            ['Separate shells per note', 'separatedShells', 'toggle'],
            ['Output RegExp cleaner', 'regexpCleaner', 'text'],
            ['Lines to suppress', 'linesToSuppress', 'text'],
        ];

        advancedSettings.forEach(([name, key, type]) => {
            const setting = new Setting(containerEl).setName(name as string);
            if (type === 'toggle') {
                setting.addToggle((t) => t
                    .setValue((this.plugin.settings as any)[key])
                    .onChange(async (v) => {
                        (this.plugin.settings as any)[key] = v;
                        await this.plugin.saveSettings();
                    }));
            } else {
                (type === 'textarea' ? setting.addTextArea : setting.addText)((c) => c
                    .setValue((this.plugin.settings as any)[key])
                    .onChange(async (v) => {
                        (this.plugin.settings as any)[key] = v;
                        await this.plugin.saveSettings();
                    }));
            }
            setting.settingEl.addClass(this.plugin.settings.advanced ? '' : 'hidden');
        });
    }
}
