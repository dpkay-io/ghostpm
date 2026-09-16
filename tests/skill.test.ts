import { SKILL_CONTENT } from '../src/skill';

const LEDGER_TOOLS = [
    'get_project_state', 'track_work', 'query_tasks', 'get_task',
    'update_task', 'merge_task', 'timeline', 'set_sprint', 'open_attachment',
];
const REMOVED_TOOLS = ['start_task', 'resolve_conflict'];

describe('skill content', () => {
    it.each(LEDGER_TOOLS)('documents %s', tool => {
        expect(SKILL_CONTENT).toContain(tool);
    });

    it.each(REMOVED_TOOLS)('no longer mentions %s', tool => {
        expect(SKILL_CONTENT).not.toContain(tool);
    });
});
