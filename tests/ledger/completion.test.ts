import { tempLedger, TempLedger, clonedRepo, outboxRows } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { getTask, insertVendorLink, updateTask } from '../../src/ledger/tasks';
import { listEvents } from '../../src/ledger/events';
import { startSession } from '../../src/ledger/sessions';
import { markVerified, recordEvidence, trackWork } from '../../src/ledger/work';
import { activeLine, completionGuidance, describeCompletion } from '../../src/ledger/completion';
import {
    setSetting, setWorkspaceSetting, COMPLETION_REVIEW, SETTING_COMPLETION, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO,
} from '../../src/ledger/settings';
import { TaskRow } from '../../src/ledger/types';

const SESSION = 'claude-verify';
const OTHER_SESSION = 'claude-other';
const SOURCE = 'mcp:test';
const VERIFIED = 'npm test: 1200 passed; build clean';
const AZURE_REMOTE = 'https://dev.azure.com/acme/Widgets/_git/widgets';

describe('completion', () => {
    let ledger: TempLedger;
    let workspaceId: number;
    let repo: string;

    const track = (title = 'Login fix', session = SESSION): TaskRow =>
        trackWork(ledger.db, { sessionId: session, source: SOURCE, workspaceId, title, intent: 'implement' }).task;
    const commit = (task: TaskRow, session = SESSION): void => {
        recordEvidence(ledger.db, { taskId: task.id, sessionId: session, source: SOURCE, workspaceId, cwd: repo, files: [], committed: true, prUrls: [] });
    };
    const verify = (task: TaskRow, verified = VERIFIED, session = SESSION) =>
        markVerified(ledger.db, { taskId: task.id, sessionId: session, source: SOURCE, verified });
    const review = (): void => setWorkspaceSetting(ledger.db, workspaceId, SETTING_COMPLETION, COMPLETION_REVIEW);
    const link = (task: TaskRow, remoteId = '12'): void => insertVendorLink(ledger.db, {
        taskId: task.id, vendor: ensureWorkspace(ledger.db, repo).vendor, remoteId, remoteState: 'open', labels: '[]',
    });

    beforeEach(() => {
        ledger = tempLedger();
        repo = clonedRepo(ledger.dir, 'repo');
        workspaceId = ensureWorkspace(ledger.db, repo).id;
        for (const id of [SESSION, OTHER_SESSION]) startSession(ledger.db, { id, client: 'claude-code', cwd: repo, workspaceId });
    });

    afterEach(() => ledger.cleanup());

    describe('markVerified', () => {
        it('refuses under ask, the default: Claude changes a phase only when the user asks', () => {
            const task = track();
            commit(task);
            expect(() => verify(task)).toThrow('completion is ask');
            expect(getTask(ledger.db, task.id)!.phase).toBe('in_progress');
        });

        it('moves the session\'s own committed task to in_review, records what was verified, and is not a human change', () => {
            review();
            const task = track();
            commit(task);
            const result = verify(task);
            expect(result.moved).toBe(true);
            expect(result.task).toMatchObject({ phase: 'in_review', human_phase_at: null });
            const comments = listEvents(ledger.db, { taskId: task.id, kinds: ['comment'] });
            expect(JSON.parse(comments[comments.length - 1].payload!)).toEqual({ text: `Verified: ${VERIFIED}` });
        });

        it('follows a global completion setting, and a workspace value beats it', () => {
            setSetting(ledger.db, SETTING_COMPLETION, COMPLETION_REVIEW);
            const task = track();
            commit(task);
            expect(verify(task).task.phase).toBe('in_review');
            setWorkspaceSetting(ledger.db, workspaceId, SETTING_COMPLETION, 'ask');
            expect(() => verify(task)).toThrow('completion is ask');
        });

        it("refuses another session's task, so one session never closes out work it did not do", () => {
            review();
            const task = track('Theirs', OTHER_SESSION);
            commit(task, OTHER_SESSION);
            expect(() => verify(task)).toThrow('is not the task this session works on');
            expect(getTask(ledger.db, task.id)!.phase).toBe('in_progress');
        });

        it('refuses a task with no commit or PR, and an empty verification', () => {
            review();
            const task = track();
            expect(() => verify(task)).toThrow('has no commit or PR recorded yet');
            commit(task);
            expect(() => verify(task, '   ')).toThrow('verified must say what you checked');
        });

        it('refuses a closed task, and after a reopen needs a new commit: the old one was already delivered', () => {
            review();
            const task = track();
            commit(task);
            updateTask(ledger.db, task.id, { phase: 'done' }, { source: SOURCE, sessionId: SESSION, human: true });
            expect(() => verify(task)).toThrow('is done');
            const reopened = trackWork(ledger.db, { sessionId: SESSION, source: SOURCE, workspaceId, title: 'More', intent: 'fix', taskRef: `T${task.id}` }).task;
            expect(reopened.phase).toBe('in_progress');
            expect(() => verify(reopened)).toThrow('has no commit or PR recorded yet');
            commit(reopened);
            expect(verify(reopened).task.phase).toBe('in_review');
        });

        it('records the verification without a move for a task already in review (a PR was opened)', () => {
            review();
            const task = track();
            recordEvidence(ledger.db, {
                taskId: task.id, sessionId: SESSION, source: SOURCE, workspaceId, cwd: repo, files: [], committed: false,
                prUrls: ['https://github.com/acme/widgets/pull/3'],
            });
            const result = verify(task);
            expect(result).toMatchObject({ moved: false, task: { phase: 'in_review' } });
        });

        it('queues the move and the verification for the vendor item', () => {
            review();
            setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
            const task = track();
            link(task);
            ledger.db.prepare('DELETE FROM outbox').run();
            commit(task);
            verify(task);
            const rows = outboxRows(ledger.db, task.id).map(row => [row.op, row.payload === null ? null : JSON.parse(row.payload).text]);
            expect(rows).toContainEqual(['sync_state', null]);
            expect(rows).toContainEqual(['comment', `Verified: ${VERIFIED}`]);
        });
    });

    describe('the prompt guidance', () => {
        it('says nothing more than the active task under ask, as 2.0 did', () => {
            const task = track();
            expect(activeLine(ledger.db, task)).toBe(`Active: T${task.id} Login fix · planned`);
            expect(describeCompletion(ledger.db, workspaceId)).toMatch(/^ask /);
        });

        it('under review tells Claude how to finish, and for a GitHub issue to use its closing keywords', () => {
            review();
            const task = track();
            expect(completionGuidance(ledger.db, task)).not.toContain('Refs');   // not linked yet
            link(task, '49');
            const line = activeLine(ledger.db, task);
            expect(line).toContain(`Completion: review`);
            expect(line).toContain(`update_task task_id=T${task.id} verified=`);
            expect(line).toContain('Never mark it done yourself');
            expect(line).toContain('GitHub #49');
            expect(line).toContain('"Refs #49"');
            expect(line).toContain('"Fixes #49"');
            expect(describeCompletion(ledger.db, workspaceId)).toMatch(/^review /);
        });

        it('for an Azure DevOps work item, mentions its id to link commits and no closing keyword', () => {
            const azure = clonedRepo(ledger.dir, 'azure', AZURE_REMOTE);
            workspaceId = ensureWorkspace(ledger.db, azure).id;
            repo = azure;
            review();
            const task = track();
            link(task, '7');
            const guidance = completionGuidance(ledger.db, task);
            expect(guidance).toContain('Azure DevOps #7');
            expect(guidance).toContain('mention "#7"');
            expect(guidance).not.toContain('Fixes');
        });

        it('says nothing for a closed task, nor through a broken link', () => {
            review();
            const task = track();
            link(task);
            ledger.db.prepare('UPDATE vendor_links SET broken_at = ? WHERE task_id = ?').run(new Date().toISOString(), task.id);
            expect(completionGuidance(ledger.db, task)).not.toContain('#12');
            const done = updateTask(ledger.db, task.id, { phase: 'done' }, { source: SOURCE, human: true });
            expect(completionGuidance(ledger.db, done)).toBe('');
        });
    });
});
