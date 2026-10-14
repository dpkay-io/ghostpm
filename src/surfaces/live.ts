import { Ledger, changeWatcher } from '../ledger/db';
import { DEFAULT_COLUMNS, DashboardLine, ScreenSize, buildSnapshot, fitToScreen, paint, renderDashboard } from './dashboard';
import { ANSI, cursorTo } from './text';

/** Spec §9.3: `PRAGMA data_version` polled every 1 s. */
export const POLL_MS = 1000;
/** Live-session staleness and the header clock move without any commit, so rebuild at least this often. */
export const STALE_REFRESH_MS = 30 * 1000;
export const DEFAULT_ROWS = 24;
/** Some terminals wrap, and scroll, when the last column is written, so the frame leaves it empty. */
const RESERVED_COLUMNS = 1;
const UNLIMITED_ROWS = Number.MAX_SAFE_INTEGER;
const RESIZE = 'resize';
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/** The part of process.stdout the dashboard uses; tests pass a fake. */
export interface Screen {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
    write(chunk: string): unknown;
    on(event: 'resize', listener: () => void): unknown;
    removeListener(event: 'resize', listener: () => void): unknown;
}

export interface LiveOptions {
    screen: Screen;
    build: () => DashboardLine[];
    changed: () => boolean;
    now?: () => number;
}

export interface LiveHandle {
    stop(): void;
    readonly done: Promise<void>;
}

export interface DashboardFlags {
    once: boolean;
}

function liveSize(screen: Screen): ScreenSize {
    return { columns: (screen.columns ?? DEFAULT_COLUMNS) - RESERVED_COLUMNS, rows: screen.rows ?? DEFAULT_ROWS };
}

/** Alternate screen, then a diff redraw whenever the ledger changes (or the frame goes stale). */
export function startLive(options: LiveOptions): LiveHandle {
    const { screen, build, changed } = options;
    const now = options.now ?? Date.now;
    let lines: DashboardLine[] = [];
    let builtAt = 0;
    let shown: string[] = [];
    let stopped = false;
    let settle: { resolve: () => void; reject: (error: unknown) => void } = { resolve: () => undefined, reject: () => undefined };
    const done = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    let timer: NodeJS.Timeout | undefined;

    const draw = (full: boolean): void => {
        const next = fitToScreen(lines, liveSize(screen)).map(line => paint(line, true));
        let out = full ? ANSI.clearScreen : '';
        next.forEach((text, index) => {
            if (full || shown[index] !== text) out += `${cursorTo(index + 1)}${text}${ANSI.eraseLine}`;
        });
        if (!full && next.length < shown.length) out += `${cursorTo(next.length + 1)}${ANSI.eraseDown}`;
        if (out.length > 0) screen.write(out);
        shown = next;
    };

    const onResize = (): void => {
        try {
            draw(true);
        } catch (error) {
            finish(error);
        }
    };

    const finish = (error?: unknown): void => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        screen.removeListener(RESIZE, onResize);
        screen.write(`${ANSI.showCursor}${ANSI.altScreenOff}`);
        if (error === undefined) settle.resolve();
        else settle.reject(error);
    };

    const tick = (): void => {
        try {
            if (!changed() && now() - builtAt < STALE_REFRESH_MS) return;
            lines = build();
            builtAt = now();
            draw(false);
        } catch (error) {
            // Never leave the user on the alternate screen with a hidden cursor.
            finish(error);
        }
    };

    screen.write(`${ANSI.altScreenOn}${ANSI.hideCursor}`);
    try {
        lines = build();
        builtAt = now();
        draw(true);
    } catch (error) {
        finish(error);
        return { stop: () => undefined, done };
    }
    timer = setInterval(tick, POLL_MS);
    screen.on(RESIZE, onResize);
    return { stop: () => finish(), done };
}

export async function runDashboard(db: Ledger, screen: Screen, flags: DashboardFlags): Promise<void> {
    const build = (): DashboardLine[] => renderDashboard(buildSnapshot(db));
    if (!screen.isTTY) {
        // Piped, redirected, or run by a tool such as Claude Code's Bash: one plain snapshot,
        // no escape codes, no loop.
        screen.write(`${build().map(line => line.text).join('\n')}\n`);
        return;
    }
    if (flags.once) {
        const size = { columns: liveSize(screen).columns, rows: UNLIMITED_ROWS };
        screen.write(`${fitToScreen(build(), size).map(line => paint(line, true)).join('\n')}\n`);
        return;
    }
    // The baseline is taken before the first frame is built, so a commit landing in between
    // shows up as a change on the next poll instead of being missed.
    const changed = changeWatcher(db);
    const live = startLive({ screen, build, changed });
    const stop = (): void => live.stop();
    STOP_SIGNALS.forEach(signal => process.once(signal, stop));
    try {
        await live.done;
    } finally {
        STOP_SIGNALS.forEach(signal => process.removeListener(signal, stop));
    }
}
