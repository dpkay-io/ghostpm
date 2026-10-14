import * as fs from 'fs';
import * as path from 'path';
import { HELP_TEXT, PLUGIN_ID, SETUP_USAGE } from '../src/help';
import { CONFIG_USAGE } from '../src/config-cli';
import {
    FLAG_ALL, FLAG_ONCE, FLAG_RESTORE, FLAG_SINCE, FLAG_STATUSLINE, FLAG_VERSION, FLAG_VERSION_SHORT, FLAG_YES,
} from '../src/cli-args';

const ROOT = path.join(__dirname, '..');
const CLI_SOURCE = path.join(ROOT, 'src', 'cli-main.ts');
const CASE_LABEL = /case ['"]([^'"]+)['"]:/g;
const SEPARATORS = /[\s,|[\]]+/;
const USAGE_PREFIX = 'Usage: ghostpm ';

/** Every command cli-main.ts handles, read from its source so a new case cannot hide from help. */
function handledCommands(): string[] {
    const source = fs.readFileSync(CLI_SOURCE, 'utf8');
    const found: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = CASE_LABEL.exec(source)) !== null) {
        if (found.indexOf(match[1]) < 0) found.push(match[1]);
    }
    return found;
}

const mentions = (word: string): boolean => HELP_TEXT.split(SEPARATORS).indexOf(word) >= 0;

describe('help', () => {
    const commands = handledCommands();

    it('finds the commands it checks', () => {
        expect(commands).toEqual(expect.arrayContaining(['dashboard', 'standup', 'tasks', 'status', 'init', 'unregister', 'sync', 'config', 'doctor', 'statusline', 'serve']));
    });

    // `|` counts as a separator so sub-commands such as `config get|set|unset` are found too.
    it.each(commands)('documents %s', command => {
        expect(mentions(command)).toBe(true);
    });

    it.each([FLAG_VERSION, FLAG_VERSION_SHORT, FLAG_ONCE, FLAG_SINCE, FLAG_ALL, FLAG_YES, FLAG_STATUSLINE, FLAG_RESTORE])('documents %s', flag => {
        expect(mentions(flag)).toBe(true);
    });

    it('makes none of the 1.4.0 claims 2.0 dropped', () => {
        expect(HELP_TEXT).not.toMatch(/auto-register|setup --global|cached tasks/i);
    });

    it('describes what init, unregister, tasks and sync do now', () => {
        expect(HELP_TEXT).toMatch(/init\s+Register/);
        expect(HELP_TEXT).toMatch(/turns? (vendor )?sync on/i);
        expect(HELP_TEXT).toMatch(/unregister[^\n]*\n?[^\n]*Forget/);
        expect(HELP_TEXT).toContain(`${FLAG_YES} deletes`);
        expect(HELP_TEXT).toMatch(/ledger/i);
        expect(HELP_TEXT).toMatch(/sync is off|off until/i);
        expect(HELP_TEXT).toMatch(/exits 1/i);
    });

    it('takes the config line from CONFIG_USAGE and the setup lines from SETUP_USAGE', () => {
        expect(HELP_TEXT).toContain(CONFIG_USAGE.slice(USAGE_PREFIX.length));
        expect(HELP_TEXT).toContain(SETUP_USAGE);
        expect(SETUP_USAGE).toContain(FLAG_STATUSLINE);
        expect(SETUP_USAGE).toContain(FLAG_RESTORE);
        expect(SETUP_USAGE).not.toContain('--global');
    });

    // tests/version.test.ts holds PLUGIN_ID to the release marketplace and plugin.json.
    it('tells Claude Code users to install the plugin by its id', () => {
        expect(HELP_TEXT).toContain(`claude plugin install ${PLUGIN_ID}`);
    });
});










const REGEX_SPECIAL = /[.*+?^${}()|[]\]/g;