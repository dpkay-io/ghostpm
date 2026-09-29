import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { openLedger, LEDGER_FILE } from '../../src/ledger/db';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { removeTempDir } from '../temp-dir';

const DIST = path.join(__dirname, '..', '..', 'dist');
// Separate OS processes can only load the built modules; `npm run build` must run first.
const describeBuilt = fs.existsSync(path.join(DIST, 'sync', 'outbox.js')) ? describe : describe.skip;

const WORKERS = 4;
const ROWS = 200;
const TIMEOUT_MS = 60000;
const POLL_MS = 20;
// Pushing a claimed row takes a moment, so no worker can drain the queue before the others start.
const PUSH_MS = 3;
const EPOCH = '1970-01-01T00:00:00.000Z';

// Each worker announces itself, waits for the start signal so all of them race, then claims and completes rows until none are left.
const WORKER_SOURCE = `
const { openLedger } = require(process.argv[2]);
const { claimNext, completeRow } = require(process.argv[3]);
const fs = require('fs');
const path = require('path');
const db = openLedger(process.argv[4]);
const signalDir = process.argv[5];
fs.writeFileSync(path.join(signalDir, 'ready-' + process.pid), '');
while (!fs.existsSync(path.join(signalDir, 'go'))) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
const holder = 'pid:' + process.pid;
const taken = [];
for (;;) {
    const row = claimNext(db, holder, Date.now());
    if (!row) break;
    taken.push(row.id);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${PUSH_MS});
    completeRow(db, row.id, holder);
}
db.close();
process.stdout.write(JSON.stringify(taken));
`;

function runWorker(script: string, ledgerFile: string, signalDir: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
        execFile(
            process.execPath,
            [script, path.join(DIST, 'ledger', 'db.js'), path.join(DIST, 'sync', 'outbox.js'), ledgerFile, signalDir],
            (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout) as number[])),
        );
    });
}

describeBuilt('claiming the outbox from several processes at once', () => {
    let dir: string;

    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-claims-')); });
    afterAll(() => removeTempDir(dir));

    it('hands every row to exactly one process (spec §13)', async () => {
        const ledgerFile = path.join(dir, LEDGER_FILE);
        const script = path.join(dir, 'worker.js');
        fs.writeFileSync(script, WORKER_SOURCE);

        const db = openLedger(ledgerFile);
        const workspaceId = ensureWorkspace(db, dir).id;
        const task = createTask(db, { title: 'Busy', phase: 'planned', workspaceId, origin: 'local', source: 'test' });
        const insert = db.prepare("INSERT INTO outbox (task_id, op, status, next_attempt_at) VALUES (?, 'comment', 'pending', ?)");
        db.transaction(() => { for (let i = 0; i < ROWS; i++) insert.run(task.id, EPOCH); })();
        db.close();

        const signalDir = fs.mkdtempSync(path.join(dir, 'signal-'));
        const running = Promise.all(Array.from({ length: WORKERS }, () => runWorker(script, ledgerFile, signalDir)));
        while (fs.readdirSync(signalDir).filter(name => name.startsWith('ready-')).length < WORKERS) {
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
        }
        fs.writeFileSync(path.join(signalDir, 'go'), '');
        const taken = await running;        const all = ([] as number[]).concat(...taken);
        expect(all).toHaveLength(ROWS);
        expect(new Set(all).size).toBe(ROWS);
        taken.forEach(rows => expect(rows.length).toBeGreaterThan(0));
    }, TIMEOUT_MS);
});
