import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { listEvents } from '../../src/ledger/events';
import { startSession, setSessionTask } from '../../src/ledger/sessions';
import { EventKind, TaskRow } from '../../src/ledger/types';
import { readPayload, ToolCall } from '../../src/hook/payload';
import { handleWith, HOOK_CLIENT } from '../../src/hook/handlers';

const SESSION_ID = 'claude-evidence';

describe('PostToolBatch evidence', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;
    let active: TaskRow;

    const batch = (...toolCalls: ToolCall[]): string | null =>
        handleWith(ledger.db, readPayload(JSON.stringify({
            hook_event_name: 'PostToolBatch', session_id: SESSION_ID, cwd: repo, tool_calls: toolCalls,
        }), 'PostToolBatch'));

    const kindsFor = (taskId: number): EventKind[] =>
        listEvents(ledger.db, { taskId }).map(entry => entry.kind);

    const payloadsOf = (taskId: number, kind: EventKind): any[] =>
        listEvents(ledger.db, { taskId, kinds: [kind] })
            .map(entry => (entry.payload === null ? null : JSON.parse(entry.payload)));

    beforeEach(() => {
        ledger = tempLedger();
        repo = path.join(ledger.dir, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        workspaceId = ensureWorkspace(ledger.db, repo).id;
        active = createTask(ledger.db, { title: 'Login fix', phase: 'in_progress', workspaceId, origin: 'local', source: 'test' });
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        setSessionTask(ledger.db, SESSION_ID, active.id);
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('records the files touched by Write and Edit in one event per batch, injecting nothing', () => {
        const injected = batch(
            { tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } },
            { tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } },
        );

        // Asserting null only means something next to proof the handler ran: alone it
        // passes whether or not PostToolBatch is handled at all.
        expect(injected).toBeNull();
        const progress = payloadsOf(active.id, 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].files).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('lists each touched file once however many times it was edited', () => {
        batch(
            { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } },
            { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } },
        );

        expect(payloadsOf(active.id, 'progress')[0].files).toEqual(['src/a.ts']);
    });

    it('records a commit event when a Bash call commits', () => {
        batch({ tool_name: 'Bash', tool_input: { command: 'git commit -m "fix upload"' } });

        expect(kindsFor(active.id)).toContain('commit');
    });

    it('does not treat every git command as a commit', () => {
        batch({ tool_name: 'Bash', tool_input: { command: 'git status' } });

        expect(kindsFor(active.id)).not.toContain('commit');
    });

    it('records a pr event with the URL a pr create prints', () => {
        batch({
            tool_name: 'Bash',
            tool_input: { command: 'gh pr create --fill' },
            tool_response: 'https://github.com/acme/app/pull/42\n',
        });

        const prs = payloadsOf(active.id, 'pr');
        expect(prs).toHaveLength(1);
        expect(prs[0].url).toBe('https://github.com/acme/app/pull/42');
    });

    it('records nothing at all when the session has no task', () => {
        setSessionTask(ledger.db, SESSION_ID, null);

        batch({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } });

        expect(kindsFor(active.id)).toEqual(['created']);
    });

    it('records nothing for a batch with no evidence in it', () => {
        batch({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } });

        expect(kindsFor(active.id)).toEqual(['created']);
    });
});
