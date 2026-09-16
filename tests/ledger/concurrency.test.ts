import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { openLedger, LEDGER_FILE } from '../../src/ledger/db';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { removeTempDir } from '../temp-dir';

const DIST = path.join(__dirname, '..', '..', 'dist');
// Separate OS processes can only load the built ledger; `npm run build` must run first.
const describeBuilt = fs.existsSync(path.join(DIST, 'ledger', 'db.js')) ? describe : describe.skip;

const WORKERS = 4;
const TASKS_PER_WORKER = 25;
const TIMEOUT_MS = 60000;

// Each worker opens the same ledger file in its own process and writes through write(),
// which is where WAL + busy_timeout have to serialise the writers (spec §4).
const WORKER_SOURCE = `
const { openLedger } = require(process.argv[2]);
const { createTask } = require(process.argv[3]);
const db = openLedger(process.argv[4]);
const workspaceId = Number(process.argv[5]);
const count = Number(process.argv[6]);
for (let i = 0; i < count; i++) {
    createTask(db, {
        title: 'pid' + process.pid + '-' + i,
        phase: 'planned',
        workspaceId: workspaceId,
        origin: 'local',
        source: 'concurrency',
    });
}
db.close();
`;

function runWorker(script: string, ledgerFile: string, workspaceId: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            process.execPath,
            [
                script,
                path.join(DIST, 'ledger', 'db.js'),
                path.join(DIST, 'ledger', 'tasks.js'),
                ledgerFile,
                String(workspaceId),
                String(TASKS_PER_WORKER),
            ],
            (error, _stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stderr)),
        );
    });
}

describeBuilt('concurrent writers across processes', () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-concurrency-'));
    });

    afterAll(() => {
        removeTempDir(dir);
    });

    it('serialises writes from separate processes without losing any', async () => {
        const ledgerFile = path.join(dir, LEDGER_FILE);
        const script = path.join(dir, 'worker.js');
        fs.writeFileSync(script, WORKER_SOURCE);

        const setup = openLedger(ledgerFile);
        const workspaceId = ensureWorkspace(setup, dir).id;
        setup.close();

        const stderrs = await Promise.all(
            Array.from({ length: WORKERS }, () => runWorker(script, ledgerFile, workspaceId)),
        );
        expect(stderrs.join('')).toBe('');

        const db = openLedger(ledgerFile);
        try {
            const expected = WORKERS * TASKS_PER_WORKER;
            const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
            expect(tasks.n).toBe(expected);
            // One 'created' event per task proves each event+projection transaction committed whole.
            const events = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'created'").get() as { n: number };
            expect(events.n).toBe(expected);
            const distinct = db.prepare('SELECT COUNT(DISTINCT title) AS n FROM tasks').get() as { n: number };
            expect(distinct.n).toBe(expected);
        } finally {
            db.close();
        }
    }, TIMEOUT_MS);
});
