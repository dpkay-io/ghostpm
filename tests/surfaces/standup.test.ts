import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask, updateTask } from '../../src/ledger/tasks';
import { recordEvent } from '../../src/ledger/events';
import { MS_PER_HOUR } from '../../src/ledger/db';
import { formatTaskId } from '../../src/ledger/types';
import { buildStandup, defaultStandupSince, DEFAULT_STANDUP_HOURS } from '../../src/surfaces/standup';
import { formatDateTime } from '../../src/surfaces/text';

const HOOK = 'hook:claude-code';

describe('buildStandup', () => {
    let ledger: TempLedger;
    let alpha: number;
    let beta: number;
    let since: Date;

    beforeEach(() => {
        ledger = tempLedger();
        const alphaDir = path.join(ledger.dir, 'alpha');
        const betaDir = path.join(ledger.dir, 'beta');
        fs.mkdirSync(alphaDir);
        fs.mkdirSync(betaDir);
        alpha = ensureWorkspace(ledger.db, alphaDir).id;
        beta = ensureWorkspace(ledger.db, betaDir).id;
        since = new Date(Date.now() - MS_PER_HOUR);
    });

    afterEach(() => ledger.cleanup());

    it('groups by workspace and task, counting files and commits once each (spec §9.4)', () => {
        const login = createTask(ledger.db, { title: 'Login fix', phase: 'planned', workspaceId: alpha, origin: 'local', source: 'test' });
        updateTask(ledger.db, login.id, { phase: 'in_progress' }, { source: 'test', human: false });
        recordEvent(ledger.db, { taskId: login.id, kind: 'progress', source: HOOK, payload: { files: ['src/a.ts', 'src/b.ts'] } });
        recordEvent(ledger.db, { taskId: login.id, kind: 'progress', source: HOOK, payload: { files: ['src/b.ts', 'src/c.ts'] } });
        recordEvent(ledger.db, { taskId: login.id, kind: 'commit', source: HOOK, payload: {} });
        recordEvent(ledger.db, { taskId: login.id, kind: 'commit', source: HOOK, payload: {} });
        recordEvent(ledger.db, { taskId: login.id, kind: 'pr', source: HOOK, payload: { url: 'https://github.com/acme/app/pull/7' } });
        const docs = createTask(ledger.db, { title: 'Docs', phase: 'planned', workspaceId: beta, origin: 'local', source: 'test' });

        const report = buildStandup(ledger.db, since);

        expect(report.startsWith(`Standup since ${formatDateTime(since)}\n2 tasks in 2 workspaces`)).toBe(true);
        expect(report).toContain([
            'alpha',
            `  ${formatTaskId(login.id)} Login fix · in_progress`,
            '    - created (planned)',
            '    - planned → in_progress',
            '    - PR https://github.com/acme/app/pull/7',
            '    - edited 3 files',
            '    - 2 commits',
        ].join('\n'));
        expect(report).toContain(['beta', `  ${formatTaskId(docs.id)} Docs · planned`, '    - created (planned)'].join('\n'));
        expect(report).not.toContain('undefined');
    });

    it('leaves out what happened before --since', () => {
        const old = createTask(ledger.db, { title: 'Old work', phase: 'planned', workspaceId: alpha, origin: 'local', source: 'test' });
        recordEvent(ledger.db, { taskId: old.id, kind: 'comment', source: 'test', payload: { text: 'earlier' } });
        const future = new Date(Date.now() + MS_PER_HOUR);

        const report = buildStandup(ledger.db, future);

        expect(report).toBe(`Standup since ${formatDateTime(future)}\n\nNothing recorded.`);
    });

    it('prints a hostile title and comment on one line each, without control characters', () => {
        createTask(ledger.db, { title: 'Evil\n  - fake line\u001b[2J', phase: 'planned', workspaceId: alpha, origin: 'local', source: 'test' });

        const report = buildStandup(ledger.db, since);

        expect(report).not.toContain('\u001b');
        expect(report.split('\n').filter(line => line.indexOf('fake line') >= 0)).toHaveLength(1);
    });

    it('defaults to the last DEFAULT_STANDUP_HOURS hours', () => {
        const now = Date.UTC(2026, 8, 30, 12);
        expect(defaultStandupSince(now).getTime()).toBe(now - DEFAULT_STANDUP_HOURS * MS_PER_HOUR);
    });
});
