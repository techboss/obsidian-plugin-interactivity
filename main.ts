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
    blockDelimiter: string;
    useJsonProtocol: boolean;
}

// JSON message structure for Python communication
interface PythonMessage {
    command: string;
    frontmatter: Record<string, any>;
    context: {
        notePath: string;
        cursorLine: number;
        selectedText?: string;
    };
}

// Extract YAML frontmatter from note content
function extractFrontmatter(content: string): Record<string, any> {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const yaml = match[1];
    const result: Record<string, any> = {};

    // Simple YAML parsing for key: value pairs
    for (const line of yaml.split('\n')) {
        const keyValue = line.match(/^(\w+):\s*(.*)$/);
        if (keyValue) {
            const [, key, value] = keyValue;
            // Handle quoted strings
            if (value.startsWith('"') && value.endsWith('"')) {
                result[key] = value.slice(1, -1);
            } else if (value.startsWith("'") && value.endsWith("'")) {
                result[key] = value.slice(1, -1);
            } else if (value === 'true') {
                result[key] = true;
            } else if (value === 'false') {
                result[key] = false;
            } else if (!isNaN(Number(value)) && value !== '') {
                result[key] = Number(value);
            } else {
                result[key] = value;
            }
        }
    }
    return result;
}

// Find block content between %%% delimiters containing the cursor
function findBlockAtCursor(editor: Editor, delimiter: string): { content: string; startLine: number; endLine: number } | null {
    const cursor = editor.getCursor();
    const totalLines = editor.lineCount();

    // Find all delimiter positions (more lenient matching)
    const delimiterLines: number[] = [];
    const delimTrimmed = delimiter.trim();

    for (let i = 0; i < totalLines; i++) {
        const line = editor.getLine(i);
        const lineTrimmed = line.trim();
        // Match if line equals delimiter, or starts with delimiter (allowing trailing content)
        if (lineTrimmed === delimTrimmed || lineTrimmed.startsWith(delimTrimmed + ' ') || lineTrimmed === delimTrimmed) {
            delimiterLines.push(i);
        }
    }

    // Need at least 2 delimiters for a block
    if (delimiterLines.length < 2) return null;

    // Find which block the cursor is in (or on)
    // Try paired matching first
    for (let i = 0; i < delimiterLines.length - 1; i++) {
        const startLine = delimiterLines[i];
        const endLine = delimiterLines[i + 1];

        // Cursor is inside or on the block delimiters
        if (cursor.line >= startLine && cursor.line <= endLine) {
            const lines: string[] = [];
            for (let j = startLine + 1; j < endLine; j++) {
                lines.push(editor.getLine(j));
            }

            return {
                content: lines.join('\n'),
                startLine,
                endLine
            };
        }
    }

    return null;
}

// Apply shortcut transformations to content
function applyShortcuts(content: string, shortcuts: string): string {
    const lines = content.split('\n');
    const firstLine = lines[0] ?? '';
    let matchedShortcutLen = 0;
    let result = content;

    for (const shortcutDef of shortcuts.split('\n')) {
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

            // Check if ##param## is already inside triple quotes in the template
            const alreadyQuoted = template.includes('"""##param##') ||
                                  template.includes("'''##param##") ||
                                  template.includes('##param##"""') ||
                                  template.includes("##param##'''");

            if (alreadyQuoted) {
                // Template already has quotes - just do simple replacement
                // Escape internal triple quotes in the param
                param = param.replace(/"""/g, '\\"""');
                result = template.replace(/##param##/g, param);
            } else {
                // Template needs quotes added around param
                param = param.replace(/"""/g, '\\"""'); // Escape internal triple quotes
                const useRaw = template.includes('r##param##');
                const quotedParam = (useRaw ? 'r' : '') + '"""' + param + '"""';

                result = template
                    .replace(/##param##/g, quotedParam)
                    .replace(/r##param##/g, quotedParam);
            }
        }
    }

    return result;
}

const DEFAULT_SETTINGS: InteractivityPluginSettings = {
    shellExec: 'python',
    shellParams: '-uq\n##plugin##py_manager.py\n',
    executeOnLoad: 'openai.api_key = "sk-"\n',
    notice: false,
    decorateMultiline: true,
    linesToSuppress: 0,
    separatedShells: false,
    prependOutput: '>>> ',
    enviromentVariables: 'PYTHONIOENCODING=utf8\n',
    executeOnUnload: 'exit()\n',
    regexpCleaner: '^((>>> )|(\\.\\.\\. ))+',
    shortcuts: '@ -> ##param##\n@@ -> chat(##param##)\n',
    advanced: false,
    blockDelimiter: '%%%',
    useJsonProtocol: true,
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
                    if (!activeEditor) {
                        that.statusBarItemEl.setText('');
                        return;
                    }

                    let selection = activeEditor.getSelection();
                    let commandText = '';
                    let blockInfo: { startLine: number; endLine: number } | null = null;

                    // Priority 1: Check for %%% block at cursor (if no selection)
                    if (!selection.trim() && that.settings.blockDelimiter) {
                        const block = findBlockAtCursor(activeEditor, that.settings.blockDelimiter);
                        if (block) {
                            // Apply shortcut transformations to block content
                            commandText = applyShortcuts(block.content, that.settings.shortcuts);
                            blockInfo = { startLine: block.startLine, endLine: block.endLine };
                        }
                    }

                    // Priority 2: Use selection - strip %%% delimiters if present
                    if (!commandText && selection.trim()) {
                        const delimiter = that.settings.blockDelimiter;
                        if (delimiter && selection.includes(delimiter)) {
                            // Strip delimiters and extract content between them
                            const delimRegex = new RegExp(`^\\s*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)\\n\\s*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
                            const match = selection.match(delimRegex);
                            if (match) {
                                // Apply shortcut transformations to block content
                                commandText = applyShortcuts(match[1], that.settings.shortcuts);
                            }
                        }
                    }

                    // Priority 3: Selection with shortcut processing
                    if (!commandText && selection.trim()) {
                        commandText = applyShortcuts(selection, that.settings.shortcuts);
                    }

                    if (!commandText.trim()) {
                        that.statusBarItemEl.setText('');
                        if (!selection.trim()) {
                            new Notice('No %%% block found at cursor position');
                        }
                        return;
                    }

                    // Move cursor to end of current line
                    activeEditor.setCursor({ line: currentLine, ch: activeEditor.getLine(currentLine).length });

                    // Execute
                    if (that.advanced) {
                        if (that.settings.useJsonProtocol) {
                            // Build JSON message with frontmatter and context
                            const noteContent = that.app.workspace.getActiveFile()
                                ? that.app.vault.cachedRead(that.app.workspace.getActiveFile()!)
                                : Promise.resolve('');

                            noteContent.then((content) => {
                                const message: PythonMessage = {
                                    command: commandText,
                                    frontmatter: extractFrontmatter(content),
                                    context: {
                                        notePath: that.app.workspace.getActiveFile()?.path ?? '',
                                        cursorLine: currentLine,
                                        selectedText: selection || undefined
                                    }
                                };
                                that.allSubprocesses[fileKey].stdin.write(JSON.stringify(message) + '\n');
                            });
                        } else {
                            // Legacy plain text protocol
                            that.allSubprocesses[fileKey].stdin.write(commandText + '\n');
                        }
                    } else {
                        let output: any;
                        try {
                            output = __EVAL(commandText);
                        } catch (e) {
                            output = e;
                        }
                        if (output !== undefined && that.processingNote === that.app.workspace.getActiveFile()?.path) {
                            that.insertText(activeEditor, output.toString(), that.settings.decorateMultiline, that.settings.prependOutput, that.settings.notice);
                            that.statusBarItemEl.setText('');
                        }
                    }
                };

                this.processingNote = this.app.workspace.getActiveFile()?.path ?? '';

                if (this.byEnter) {
                    const lineIdx = cursor.line - 1;
                    const lineText = editor.getLine(lineIdx).trim();
                    const delimiter = this.settings.blockDelimiter;

                    // Check if previous line is a closing %%% delimiter
                    if (delimiter && lineText === delimiter) {
                        // Count all %%% delimiters above this line
                        // If count is ODD, this line is a CLOSING delimiter (execute block)
                        // If count is EVEN, this line is an OPENING delimiter (do nothing)
                        let delimiterCount = 0;
                        let lastDelimiterLine = -1;
                        for (let i = 0; i < lineIdx; i++) {
                            if (editor.getLine(i).trim() === delimiter) {
                                delimiterCount++;
                                lastDelimiterLine = i;
                            }
                        }

                        // If odd count above, this is a closing delimiter
                        if (delimiterCount % 2 === 1 && lastDelimiterLine >= 0) {
                            const openingLine = lastDelimiterLine;
                            // Found a complete block - extract content
                            const blockLines: string[] = [];
                            for (let i = openingLine + 1; i < lineIdx; i++) {
                                blockLines.push(editor.getLine(i));
                            }
                            const rawBlockContent = blockLines.join('\n');

                            if (rawBlockContent.trim()) {
                                // Apply shortcut transformations to block content
                                const blockContent = applyShortcuts(rawBlockContent, this.settings.shortcuts);

                                this.statusBarItemEl.setText('Interactivity is busy⏳');

                                // Remove the newline that Enter just created
                                editor.replaceRange('', { line: lineIdx, ch: editor.getLine(lineIdx).length }, { line: cursor.line, ch: cursor.ch });

                                // Move cursor to end of closing delimiter line
                                editor.setCursor({ line: lineIdx, ch: editor.getLine(lineIdx).length });

                                // Execute with block content
                                const that = this;
                                if (this.settings.useJsonProtocol && this.advanced) {
                                    const noteContent = this.app.workspace.getActiveFile()
                                        ? this.app.vault.cachedRead(this.app.workspace.getActiveFile()!)
                                        : Promise.resolve('');

                                    noteContent.then((content) => {
                                        const message: PythonMessage = {
                                            command: blockContent,
                                            frontmatter: extractFrontmatter(content),
                                            context: {
                                                notePath: that.app.workspace.getActiveFile()?.path ?? '',
                                                cursorLine: lineIdx,
                                                selectedText: undefined
                                            }
                                        };
                                        that.allSubprocesses[fileKey].stdin.write(JSON.stringify(message) + '\n');
                                    });
                                } else if (this.advanced) {
                                    this.allSubprocesses[fileKey].stdin.write(blockContent + '\n');
                                }
                                return;
                            }
                        }
                        // Opening %%% without content or incomplete block - do nothing
                        return;
                    }

                    // Legacy shortcut handling (e.g., @ -> command)
                    let hasMatch = false;
                    for (const def of this.settings.shortcuts.split('\n')) {
                        const m = def.match(/(.*?)\s*->\s*(.*)/);
                        if (m && lineText.startsWith(m[1])) {
                            hasMatch = true;
                            break;
                        }
                    }

                    if (!hasMatch) return;

                    this.statusBarItemEl.setText('Interactivity is busy⏳');

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
                    this.statusBarItemEl.setText('Interactivity is busy⏳');
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
            const pluginDir = normalizePath(basePath + '/' + this.manifest.dir).replace(/\/$/, '') + '/';

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

        new Setting(containerEl)
            .setName('Block delimiter')
            .setDesc('Delimiter for multi-line input blocks (e.g., %%%). Place cursor inside block and execute.')
            .addText((t) => t
                .setValue(this.plugin.settings.blockDelimiter)
                .onChange((v) => {
                    this.plugin.settings.blockDelimiter = v;
                    this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Use JSON protocol')
            .setDesc('Send commands as JSON with frontmatter and context (requires compatible Python handler)')
            .addToggle((t) => t
                .setValue(this.plugin.settings.useJsonProtocol)
                .onChange((v) => {
                    this.plugin.settings.useJsonProtocol = v;
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

        // Advanced settings - only visible when advanced mode is enabled
        const hiddenClass = this.plugin.settings.advanced ? '' : 'hidden';

        const shellExecSetting = new Setting(containerEl)
            .setName('Shell executable path')
            .addText((t) => t
                .setValue(this.plugin.settings.shellExec)
                .onChange(async (v) => {
                    this.plugin.settings.shellExec = v;
                    await this.plugin.saveSettings();
                }));
        if (hiddenClass) shellExecSetting.settingEl.addClass(hiddenClass);

        const envVarsSetting = new Setting(containerEl)
            .setName('Environment variables')
            .addTextArea((t) => t
                .setValue(this.plugin.settings.enviromentVariables)
                .onChange(async (v) => {
                    this.plugin.settings.enviromentVariables = v;
                    await this.plugin.saveSettings();
                }));
        if (hiddenClass) envVarsSetting.settingEl.addClass(hiddenClass);

        const shellParamsSetting = new Setting(containerEl)
            .setName('Shell CLI arguments')
            .addTextArea((t) => t
                .setValue(this.plugin.settings.shellParams)
                .onChange(async (v) => {
                    this.plugin.settings.shellParams = v;
                    await this.plugin.saveSettings();
                }));
        if (hiddenClass) shellParamsSetting.settingEl.addClass(hiddenClass);

        const onLoadSetting = new Setting(containerEl)
            .setName('Commands on load')
            .addTextArea((t) => t
                .setValue(this.plugin.settings.executeOnLoad)
                .onChange(async (v) => {
                    this.plugin.settings.executeOnLoad = v;
                    await this.plugin.saveSettings();
                }));
        if (hiddenClass) onLoadSetting.settingEl.addClass(hiddenClass);

        const onUnloadSetting = new Setting(containerEl)
            .setName('Commands on unload')
            .addTextArea((t) => t
                .setValue(this.plugin.settings.executeOnUnload)
                .onChange(async (v) => {
                    this.plugin.settings.executeOnUnload = v;
                    await this.plugin.saveSettings();
                }));
        if (hiddenClass) onUnloadSetting.settingEl.addClass(hiddenClass);

        const separatedShellsSetting = new Setting(containerEl)
            .setName('Separate shells per note')
            .addToggle((t) => t
                .setValue(this.plugin.settings.separatedShells)
                .onChange(async (v) => {
                    this.plugin.settings.separatedShells = v;
                    await this.plugin.saveSettings();
                }));
        if (hiddenClass) separatedShellsSetting.settingEl.addClass(hiddenClass);

        const regexpSetting = new Setting(containerEl)
            .setName('Output RegExp cleaner')
            .addText((t) => t
                .setValue(this.plugin.settings.regexpCleaner)
                .onChange(async (v) => {
                    this.plugin.settings.regexpCleaner = v;
                    await this.plugin.saveSettings();
                }));
        if (hiddenClass) regexpSetting.settingEl.addClass(hiddenClass);

        const linesToSuppressSetting = new Setting(containerEl)
            .setName('Lines to suppress')
            .addText((t) => t
                .setValue(String(this.plugin.settings.linesToSuppress))
                .onChange(async (v) => {
                    this.plugin.settings.linesToSuppress = parseInt(v) || 0;
                    await this.plugin.saveSettings();
                }));
        if (hiddenClass) linesToSuppressSetting.settingEl.addClass(hiddenClass);
    }
}
