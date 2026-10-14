import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'src');
/** What only the 1.4.0 import may know about. */
const LEGACY_MARKERS = [/\.mcp-pm\.(db|yml)/, /LEGACY_DB_FILE|LEGACY_CONFIG_FILE/];
/**
 * The importer, the 1.4.0 config reader it uses, and init, which triggers a per-repo import.
 * If Phase 3 put its legacy outbox import in a module of its own, add that path here: it is
 * part of the legacy import.
 */
const ALLOWED = ['ledger/legacy-import.ts', 'config.ts', 'workspace-commands.ts'];
const REMOVED = ['engine.ts', 'db.ts', 'github-adapter.ts', 'azure-adapter.ts', 'pm-adapter.ts', 'skill.ts'];

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce<string[]>((files, entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return files.concat(sourceFiles(full));
        return entry.name.endsWith('.ts') ? files.concat(full) : files;
    }, []);
}

describe('legacy boundary', () => {
    it('no CLI path but the legacy import reads a per-repo .mcp-pm.db or .mcp-pm.yml', () => {
        const offenders = sourceFiles(SRC)
            .map(file => path.relative(SRC, file).split(path.sep).join('/'))
            .filter(file => ALLOWED.indexOf(file) < 0)
            .filter(file => LEGACY_MARKERS.some(marker => marker.test(fs.readFileSync(path.join(SRC, file), 'utf8'))));
        expect(offenders).toEqual([]);
    });

    it.each(REMOVED)('%s is gone', file => {
        expect(fs.existsSync(path.join(SRC, file))).toBe(false);
    });
});
