import * as path from 'path';
import * as fs from 'fs';
import { tempLedger, TempLedger } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask, insertVendorLink } from '../../src/ledger/tasks';
import { recordEvent } from '../../src/ledger/events';
import { setWorkspaceSetting, SETTING_CURRENT_USER } from '../../src/ledger/settings';
import { taskBranchName } from '../../src/ledger/branch';
import { Phase, TaskRow } from '../../src/ledger/types';
import {
    rankCandidates, renderCandidatePrompt, CANDIDATE_LIMIT, RECENT_DAYS, INJECTION_CHAR_BUDGET,
} from '../../src/hook/candidates';

const SESSION_ID = 'claude-rank';
const CURRENT_USER = 'dpk-jha';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('candidate ranking', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;

    const task = (title: string, phase: Phase = 'planned', assignee: string | null = null): TaskRow =>
        createTask(ledger.db, { title, phase, workspaceId, origin: 'local', source: 'test', assignee });

    const agedDays = (row: TaskRow, days: number): void => {
        const at = new Date(Date.now() - days * MS_PER_DAY).toISOString();
        ledger.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(at, row.id);
    };

    const workedOnInThisSession = (row: TaskRow): void => {
        recordEvent(ledger.db, { taskId: row.id, kind: 'progress', source: 'test', sessionId: SESSION_ID });
    };

    const rank = (branch: string | null = null): TaskRow[] =>
        rankCandidates(ledger.db, { workspaceId, sessionId: SESSION_ID, branch });

    beforeEach(() => {
        ledger = tempLedger();
        repo = path.join(ledger.dir, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        workspaceId = ensureWorkspace(ledger.db, repo).id;
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('ranks the branch task first, ahead of anything more recent', () => {
        const onBranch = task('On the branch');
        agedDays(onBranch, 10);
        task('Touched just now');

        expect(rank(taskBranchName(onBranch.id))[0].id).toBe(onBranch.id);
    });

    it('ranks tasks from this session above merely recent ones', () => {
        const recent = task('Merely recent');
        const worked = task('Worked on here');
        agedDays(worked, 3);
        agedDays(recent, 0);
        workedOnInThisSession(worked);

        const ranked = rank();
        expect(ranked[0].id).toBe(worked.id);
        expect(ranked.map(t => t.id)).toContain(recent.id);
    });

    it('includes recent workspace tasks, newest first', () => {
        const older = task('Older');
        const newer = task('Newer');
        agedDays(older, 5);
        agedDays(newer, 1);

        expect(rank().map(t => t.id)).toEqual([newer.id, older.id]);
    });

    it(`drops tasks untouched for more than ${RECENT_DAYS} days`, () => {
        const stale = task('Long forgotten');
        agedDays(stale, RECENT_DAYS + 1);

        expect(rank().map(t => t.id)).not.toContain(stale.id);
    });

    it('keeps a stale task when it is assigned to the current user on the vendor', () => {
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_CURRENT_USER, CURRENT_USER);
        const assigned = createTask(ledger.db, {
            title: 'Assigned to me', phase: 'planned', workspaceId,
            origin: 'vendor', source: 'test', assignee: CURRENT_USER,
        });
        insertVendorLink(ledger.db, { taskId: assigned.id, vendor: 'github', remoteId: '99' });
        agedDays(assigned, RECENT_DAYS + 30);

        expect(rank().map(t => t.id)).toContain(assigned.id);
    });

    it('leaves out closed work: it is reopened by track_work, not suggested', () => {
        const done = task('Shipped', 'done');
        const dropped = task('Abandoned', 'dropped');
        agedDays(done, 1);
        agedDays(dropped, 1);

        const ids = rank().map(t => t.id);
        expect(ids).not.toContain(done.id);
        expect(ids).not.toContain(dropped.id);
    });

    it('lists a task once even when it qualifies on several rules', () => {
        const overlapping = task('Qualifies twice');
        workedOnInThisSession(overlapping);

        const ids = rank(taskBranchName(overlapping.id)).map(t => t.id);
        expect(ids.filter(id => id === overlapping.id)).toHaveLength(1);
    });

    it('never crosses into another workspace', () => {
        const other = ensureWorkspace(ledger.db, path.join(ledger.dir, 'other')).id;
        const foreign = createTask(ledger.db, { title: 'Elsewhere', phase: 'planned', workspaceId: other, origin: 'local', source: 'test' });

        expect(rank().map(t => t.id)).not.toContain(foreign.id);
    });

    it(`returns at most ${CANDIDATE_LIMIT} candidates`, () => {
        for (let i = 0; i < CANDIDATE_LIMIT + 4; i++) task(`Task ${i}`);

        expect(rank().length).toBe(CANDIDATE_LIMIT);
    });
});

describe('renderCandidatePrompt', () => {
    let ledger: TempLedger;
    let workspaceId: number;

    const task = (title: string): TaskRow =>
        createTask(ledger.db, { title, phase: 'planned', workspaceId, origin: 'local', source: 'test' });

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, path.join(ledger.dir, 'repo')).id;
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('instructs the model to call track_work even with no candidates', () => {
        const text = renderCandidatePrompt([]);
        expect(text).toContain('track_work');
        expect(text.length).toBeGreaterThan(0);
    });

    it('names each candidate by its formatted id', () => {
        const one = task('Login fix');
        expect(renderCandidatePrompt([one])).toContain(`T${one.id}`);
        expect(renderCandidatePrompt([one])).toContain('Login fix');
    });

    it('stays inside the injection budget even with long titles', () => {
        const long = Array.from({ length: CANDIDATE_LIMIT }, (_, i) => task(`${'very long title '.repeat(20)}${i}`));
        const text = renderCandidatePrompt(long);
        expect(text.length).toBeLessThanOrEqual(INJECTION_CHAR_BUDGET);
        // Truncation must not cost the instruction, which is the point of the injection.
        expect(text).toContain('track_work');
    });
});
