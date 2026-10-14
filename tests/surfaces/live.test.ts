import { EventEmitter } from 'events';
import { tempLedger, TempLedger } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { DashboardLine } from '../../src/surfaces/dashboard';
import { POLL_MS, STALE_REFRESH_MS, Screen, runDashboard, startLive } from '../../src/surfaces/live';
import { ANSI, cursorTo } from '../../src/surfaces/text';

const ESCAPE = '\u001b[';

function fakeScreen(isTTY = true, columns = 40, rows = 10) {
    const writes: string[] = [];
    const listeners: { [event: string]: ((error?: Error) => void) | null } = {};
    const state = { failWrites: false };
    const screen: Screen = {
        isTTY, columns, rows,
        write: (chunk: string) => {
            if (state.failWrites) throw new Error('EPIPE');
            writes.push(chunk);
            return true;
        },
        on: (event, handler) => { listeners[event] = handler; },
        removeListener: event => { listeners[event] = null; },
    };
    const emit = (event: string, error?: Error) => { const handler = listeners[event]; if (handler) handler(error); };
    return { screen, writes, state, listeners, resize: () => emit('resize'), fail: (error: Error) => emit('error', error) };
}

const frame = (...texts: string[]): DashboardLine[] => texts.map(text => ({ text, tone: 'normal' as const }));

describe('startLive', () => {
    let clock: number;
    let lines: DashboardLine[];
    let dirty: boolean;
    let builds: number;

    const options = (screen: Screen) => ({
        screen,
        build: () => { builds++; return lines.slice(); },
        changed: () => { const was = dirty; dirty = false; return was; },
        now: () => clock,
    });

    beforeEach(() => {
        jest.useFakeTimers();
        clock = 0;
        lines = frame('A', 'B', 'C');
        dirty = false;
        builds = 0;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('takes over the screen and draws every line once', () => {
        const { screen, writes } = fakeScreen();
        const live = startLive(options(screen));

        expect(writes[0]).toBe(`${ANSI.altScreenOn}${ANSI.hideCursor}`);
        expect(writes[1]).toContain(`${cursorTo(1)}A${ANSI.eraseLine}`);
        expect(writes[1]).toContain(`${cursorTo(3)}C${ANSI.eraseLine}`);
        live.stop();
    });

    it('writes nothing while the ledger does not change', () => {
        const { screen, writes } = fakeScreen();
        const live = startLive(options(screen));
        const before = writes.length;

        jest.advanceTimersByTime(POLL_MS * 5);

        expect(writes.length).toBe(before);
        expect(builds).toBe(1);
        live.stop();
    });

    it('rewrites only the lines that changed', () => {
        const { screen, writes } = fakeScreen();
        const live = startLive(options(screen));
        lines = frame('A', 'B2', 'C');
        dirty = true;

        jest.advanceTimersByTime(POLL_MS);

        const last = writes[writes.length - 1];
        expect(last).toBe(`${cursorTo(2)}B2${ANSI.eraseLine}`);
        live.stop();
    });

    it('clears what is left below a shorter frame', () => {
        const { screen, writes } = fakeScreen();
        const live = startLive(options(screen));
        lines = frame('A');
        dirty = true;

        jest.advanceTimersByTime(POLL_MS);

        expect(writes[writes.length - 1]).toBe(`${cursorTo(2)}${ANSI.eraseDown}`);
        live.stop();
    });

    it('rebuilds at least every STALE_REFRESH_MS even without a commit', () => {
        const { screen } = fakeScreen();
        const live = startLive(options(screen));
        clock += STALE_REFRESH_MS;

        jest.advanceTimersByTime(POLL_MS);

        expect(builds).toBe(2);
        live.stop();
    });

    it('redraws everything after a resize', () => {
        const { screen, writes, resize } = fakeScreen();
        const live = startLive(options(screen));

        resize();

        const last = writes[writes.length - 1];
        expect(last.startsWith(ANSI.clearScreen)).toBe(true);
        expect(last).toContain(`${cursorTo(1)}A`);
        live.stop();
    });

    it('gives the terminal back on stop and stops polling', async () => {
        const { screen, writes } = fakeScreen();
        const live = startLive(options(screen));

        live.stop();
        await live.done;
        const after = writes.length;
        dirty = true;
        jest.advanceTimersByTime(POLL_MS * 3);

        expect(writes[after - 1]).toBe(`${ANSI.showCursor}${ANSI.altScreenOff}`);
        expect(writes.length).toBe(after);
    });

    it('gives the terminal back and reports the error when a rebuild fails', async () => {
        const { screen, writes } = fakeScreen();
        const live = startLive({ ...options(screen), build: () => { builds++; if (builds > 1) throw new Error('ledger gone'); return lines; } });
        dirty = true;

        jest.advanceTimersByTime(POLL_MS);

        await expect(live.done).rejects.toThrow('ledger gone');
        expect(writes[writes.length - 1]).toBe(`${ANSI.showCursor}${ANSI.altScreenOff}`);
    });
});

describe('startLive when things go wrong', () => {
    it('swallows a second output error after a stream-error stop', async () => {
        const { screen, emitter } = emitterScreen();
        const live = startLive({ screen, build: () => frame('A'), changed: () => false });

        emitter.emit('error', new Error('EPIPE'));
        await expect(live.done).rejects.toThrow('EPIPE');

        expect(() => emitter.emit('error', new Error('second EPIPE'))).not.toThrow();
    });

    const RESTORE = `${ANSI.showCursor}${ANSI.altScreenOff}`;
    const base = (screen: Screen, build: () => DashboardLine[] = () => frame('A')) => ({ screen, build, changed: () => false });

    it('restores the terminal and rejects when the first build throws', async () => {
        const { screen, writes } = fakeScreen();
        const live = startLive(base(screen, () => { throw new Error('no ledger'); }));

        await expect(live.done).rejects.toThrow('no ledger');
        expect(writes[writes.length - 1]).toBe(RESTORE);
    });

    it('restores the terminal when a resize redraw cannot write', async () => {
        const { screen, writes, resize } = fakeScreen();
        const live = startLive(base(screen));
        const original = screen.write;
        screen.write = chunk => {
            if (chunk.startsWith(ANSI.clearScreen)) throw new Error('write failed');
            return original(chunk);
        };

        resize();

        await expect(live.done).rejects.toThrow('write failed');
        expect(writes[writes.length - 1]).toBe(RESTORE);
    });

    it('stops and writes nothing more when the output stream fails', async () => {
        jest.useFakeTimers();
        try {
            const { screen, writes, listeners, fail } = fakeScreen();
            const live = startLive({ ...base(screen), changed: () => true });
            const before = writes.length;

            fail(new Error('EPIPE'));

            await expect(live.done).rejects.toThrow('EPIPE');
            jest.advanceTimersByTime(POLL_MS * 3);
            expect(writes.length).toBe(before);
            expect(listeners.resize).toBeNull();
            expect(() => fail(new Error('second EPIPE'))).not.toThrow();
            expect(writes.length).toBe(before);
        } finally {
            jest.useRealTimers();
        }
    });

    it('settles done even when the restore write itself throws', async () => {
        const { screen, state } = fakeScreen();
        const live = startLive(base(screen));
        state.failWrites = true;

        live.stop();

        await expect(live.done).resolves.toBeUndefined();
    });
});

/** A real emitter: an 'error' event with no listener throws, as it does on process.stdout. */
function emitterScreen(): { screen: Screen; writes: string[]; emitter: EventEmitter } {
    const emitter = new EventEmitter();
    const writes: string[] = [];
    const screen: Screen = {
        isTTY: true, columns: 40, rows: 10,
        write: (chunk: string) => { writes.push(chunk); return true; },
        on: (event, handler) => emitter.on(event, handler),
        removeListener: (event, handler) => emitter.removeListener(event, handler),
    };
    return { screen, writes, emitter };
}

describe('runDashboard', () => {
    let ledger: TempLedger;

    beforeEach(() => {
        ledger = tempLedger();
        const workspaceId = ensureWorkspace(ledger.db, ledger.dir).id;
        createTask(ledger.db, { title: 'Visible', phase: 'planned', workspaceId, origin: 'local', source: 'test' });
    });

    afterEach(() => ledger.cleanup());

    it('prints one plain snapshot when stdout is not a terminal (Review Focus 1)', async () => {
        const { screen, writes } = fakeScreen(false);

        await runDashboard(ledger.db, screen, { once: false });

        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('LIVE SESSIONS');
        expect(writes[0]).toContain('Visible');
        expect(writes[0]).not.toContain(ESCAPE);
    });

    it.each(['SIGINT', 'SIGTERM'] as NodeJS.Signals[])('restores the terminal on %s and removes its listener', async signal => {
        const { screen, writes } = fakeScreen();
        const before = process.listenerCount(signal);

        const run = runDashboard(ledger.db, screen, { once: false });
        expect(process.listenerCount(signal)).toBe(before + 1);
        process.emit(signal, signal);
        await run;

        expect(writes[writes.length - 1]).toBe(`${ANSI.showCursor}${ANSI.altScreenOff}`);
        expect(process.listenerCount(signal)).toBe(before);
    });

    it('swallows an output error that arrives after a SIGINT restore', async () => {
        const { screen, writes, emitter } = emitterScreen();
        const run = runDashboard(ledger.db, screen, { once: false });
        process.emit('SIGINT', 'SIGINT');
        await run;
        const after = writes.length;

        expect(() => emitter.emit('error', new Error('late EPIPE'))).not.toThrow();
        expect(writes.length).toBe(after);
    });

    it('prints one frame on a terminal with --once, without taking over the screen', async () => {
        const { screen, writes } = fakeScreen(true, 30, 5);

        await runDashboard(ledger.db, screen, { once: true });

        expect(writes).toHaveLength(1);
        expect(writes[0]).not.toContain(ANSI.altScreenOn);
        writes[0].replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n').forEach(line => expect(Array.from(line).length).toBeLessThanOrEqual(29));
    });
});
