import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask, updateTask, ChangeContext } from '../../src/ledger/tasks';
import { listEvents, recordEvent } from '../../src/ledger/events';
import { startSession } from '../../src/ledger/sessions';

const SOURCE = 'test';
const AUTOMATION: ChangeContext = { source: SOURCE, human: false };
const FUTURE_MS = 1000;

describe('listEvents', () => {
    let ledger: TempLedger;
    let workspaceId: number;

    const task = (title: string, taskWorkspaceId: number = workspaceId) =>
        createTask(ledger.db, { title, phase: 'planned', workspaceId: taskWorkspaceId, origin: 'local', source: SOURCE });

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, ledger.dir).id;
    });

    afterEach(() => ledger.cleanup());

    it('returns events oldest first, carrying the task title', () => {
        const created = task('Login fix');
        updateTask(ledger.db, created.id, { phase: 'in_progress' }, AUTOMATION);
        const entries = listEvents(ledger.db, { taskId: created.id });
        expect(entries.map(e => e.kind)).toEqual(['created', 'phase']);
        expect(entries[0].title).toBe('Login fix');
        expect(entries[0].seq).toBeLessThan(entries[1].seq);
    });

    it('filters by workspace', () => {
        const otherDir = path.join(ledger.dir, 'other');
        fs.mkdirSync(otherDir);
        const otherWorkspaceId = ensureWorkspace(ledger.db, otherDir).id;
        task('Here');
        task('Elsewhere', otherWorkspaceId);
        expect(listEvents(ledger.db, { workspaceId }).map(e => e.title)).toEqual(['Here']);
    });

    it('filters by kind and by start time', () => {
        const created = task('Login fix');
        updateTask(ledger.db, created.id, { comment: 'first' }, AUTOMATION);
        expect(listEvents(ledger.db, { kinds: ['comment'] }).map(e => e.kind)).toEqual(['comment']);
        expect(listEvents(ledger.db, { since: new Date(Date.now() + FUTURE_MS).toISOString() })).toEqual([]);
    });

    it('keeps the most recent events when more match than the limit', () => {
        const created = task('Login fix');
        updateTask(ledger.db, created.id, { comment: 'one' }, AUTOMATION);
        updateTask(ledger.db, created.id, { comment: 'two' }, AUTOMATION);
        const entries = listEvents(ledger.db, { taskId: created.id, limit: 2 });
        expect(entries.map(e => e.kind)).toEqual(['comment', 'comment']);
        expect(JSON.parse(entries[1].payload!)).toEqual({ text: 'two' });
    });

    it('carries the workspace of the task and of the session that recorded it', () => {
        const otherDir = path.join(ledger.dir, 'other');
        fs.mkdirSync(otherDir);
        const otherWorkspaceId = ensureWorkspace(ledger.db, otherDir).id;
        const created = task('Here');
        startSession(ledger.db, { id: 'visitor', client: 'claude-code', cwd: otherDir, workspaceId: otherWorkspaceId });
        recordEvent(ledger.db, { taskId: created.id, kind: 'comment', source: SOURCE, sessionId: 'visitor', payload: { text: 'hi' } });

        const [comment] = listEvents(ledger.db, { kinds: ['comment'] });
        expect(comment.workspace_id).toBe(workspaceId);
        expect(comment.session_workspace_id).toBe(otherWorkspaceId);
    });

    it('keeps only events recorded from another workspace when asked', () => {
        const otherDir = path.join(ledger.dir, 'other');
        fs.mkdirSync(otherDir);
        const otherWorkspaceId = ensureWorkspace(ledger.db, otherDir).id;
        const created = task('Here');
        startSession(ledger.db, { id: 'visitor', client: 'claude-code', cwd: otherDir, workspaceId: otherWorkspaceId });
        startSession(ledger.db, { id: 'local', client: 'claude-code', cwd: ledger.dir, workspaceId });
        recordEvent(ledger.db, { taskId: created.id, kind: 'comment', source: SOURCE, sessionId: 'visitor', payload: { text: 'from there' } });
        recordEvent(ledger.db, { taskId: created.id, kind: 'comment', source: SOURCE, sessionId: 'local', payload: { text: 'from here' } });

        const cross = listEvents(ledger.db, { crossWorkspaceOnly: true });
        expect(cross.map(entry => JSON.parse(entry.payload!).text)).toEqual(['from there']);
    });
});
