import { EVENT_KINDS, EventKind } from '../../src/ledger/types';
import {
    COMMENT_PREVIEW_CHARS, RenderableEvent, eventDetail, eventFiles, renderEvent,
} from '../../src/surfaces/render-event';
import { ELLIPSIS, cleanText } from '../../src/surfaces/text';
import { HOSTILE, NOT_ONE_LINE } from '../hostile-text';

const AT = '2026-09-29T10:00:00.000Z';

const event = (kind: EventKind, payload: unknown, over: Partial<RenderableEvent> = {}): RenderableEvent => ({
    at: AT,
    task_id: 42,
    title: 'Login fix',
    kind,
    payload: payload === undefined ? null : JSON.stringify(payload),
    source: 'test',
    ...over,
});

const BROKEN = /undefined|null|\[object/;

describe('eventDetail', () => {
    it.each(EVENT_KINDS.map(kind => [kind]))('renders %s with an empty, missing or malformed payload without undefined', kind => {
        expect(eventDetail(event(kind as EventKind, {}))).not.toMatch(BROKEN);
        expect(eventDetail(event(kind as EventKind, undefined))).not.toMatch(BROKEN);
        expect(eventDetail({ kind: kind as EventKind, payload: 'not json' })).not.toMatch(BROKEN);
    });

    it('names the files a hook recorded (the payload the hook actually writes)', () => {
        expect(eventDetail(event('progress', { files: ['C:\\repo\\src\\a.ts', '/repo/src/b.ts'] })))
            .toBe('edited 2 files: a.ts, b.ts');
        expect(eventDetail(event('progress', { files: ['a.ts'] }))).toBe('edited 1 file: a.ts');
        expect(eventDetail(event('progress', { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] })))
            .toBe('edited 5 files: a.ts, b.ts, c.ts +2 more');
    });

    it('renders track_work progress as intent and note', () => {
        expect(eventDetail(event('progress', { intent: 'fix', note: 'now planning' }))).toBe('fix: now planning');
    });

    it('keeps the PR URL', () => {
        expect(eventDetail(event('pr', { url: 'https://github.com/acme/app/pull/7' })))
            .toBe('PR https://github.com/acme/app/pull/7');
    });

    it('renders phase changes, renames, merges and creation', () => {
        expect(eventDetail(event('phase', { from: 'planned', to: 'in_progress' }))).toBe('planned → in_progress');
        expect(eventDetail(event('renamed', { from: 'a', to: 'b' }))).toBe('renamed to b');
        expect(eventDetail(event('merged', { into: 7 }))).toBe('merged into T7');
        expect(eventDetail(event('merged', { from: 8 }))).toBe('absorbed T8');
        expect(eventDetail(event('created', { title: 'x', phase: 'planned' }))).toBe('created (planned)');
        expect(eventDetail(event('commit', {}))).toBe('committed');
    });

    it('renders both linked shapes: a link and a vendor item that is gone', () => {
        expect(eventDetail(event('linked', { vendor: 'github', remoteId: '7', url: 'https://github.com/acme/app/issues/7' })))
            .toBe('linked https://github.com/acme/app/issues/7');
        expect(eventDetail(event('linked', { vendor: 'github', remoteId: '7', broken: true, reason: 'deleted upstream' })))
            .toBe('vendor item gone: deleted upstream');
        expect(eventDetail(event('linked', { vendor: 'github', remoteId: '7', broken: true }))).toBe('vendor item gone');
    });

    it('puts a long multi-line comment on one line', () => {
        const long = `first line\nsecond line ${'x'.repeat(COMMENT_PREVIEW_CHARS)}`;
        const detail = eventDetail(event('comment', { text: long }));
        expect(detail.startsWith('comment: first line second line')).toBe(true);
        expect(detail.indexOf('\n')).toBe(-1);
        expect(detail.endsWith(ELLIPSIS)).toBe(true);
    });
});

describe('eventFiles', () => {
    it('returns files only for hook progress events', () => {
        expect(eventFiles(event('progress', { files: ['a.ts', 7, ''] }))).toEqual(['a.ts']);
        expect(eventFiles(event('progress', { intent: 'fix', note: 'x' }))).toEqual([]);
        expect(eventFiles(event('commit', { files: ['a.ts'] }))).toEqual([]);
    });
});

describe('renderEvent', () => {
    it('prints time, task, detail and source on one line', () => {
        expect(renderEvent(event('phase', { from: 'planned', to: 'in_progress' })))
            .toBe(`- ${AT} · T42 Login fix · planned → in_progress (test)`);
    });

    it('keeps a hostile title, rename, link and source on one clean line (the MCP timeline prints it as is)', () => {
        const hostile = { title: HOSTILE, source: HOSTILE };
        [
            event('renamed', { from: 'a', to: HOSTILE }, hostile),
            event('pr', { url: HOSTILE }, hostile),
            event('linked', { url: HOSTILE }, hostile),
            event('progress', { files: [HOSTILE] }, hostile),
        ].forEach(entry => {
            const line = renderEvent(entry);
            expect(line).not.toMatch(NOT_ONE_LINE);
            expect(line).toContain(`T42 ${cleanText(HOSTILE)} · `);
        });
    });

    it('leaves out the task part for an event with no task', () => {
        expect(renderEvent(event('comment', { text: 'hi' }, { task_id: null, title: null })))
            .toBe(`- ${AT} · comment: hi (test)`);
    });
});
