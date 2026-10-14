import * as path from 'path';
import { TimelineEntry } from '../ledger/events';
import { EventRow, formatTaskId, plural } from '../ledger/types';
import { cleanText, truncate } from './text';

/** How many edited files a progress line names before counting the rest. */
export const FILES_NAMED = 3;
/** Longest comment or note shown on one line; the full text stays in the ledger. */
export const COMMENT_PREVIEW_CHARS = 160;
const LINE_BREAKS = /\s*[\r\n]+\s*/g;

type EventBody = Pick<EventRow, 'kind' | 'payload'>;
export type RenderableEvent = Pick<TimelineEntry, 'at' | 'task_id' | 'title' | 'kind' | 'payload' | 'source'>;
type Payload = { [key: string]: unknown };

/** Never throws: a missing or malformed payload renders as the bare kind. */
function parsePayload(raw: string | null): Payload {
    if (raw === null) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Payload : {};
    } catch {
        return {};
    }
}

function textField(payload: Payload, key: string): string | null {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function taskIdField(payload: Payload, key: string): number | null {
    const value = payload[key];
    return typeof value === 'number' && isFinite(value) ? value : null;
}

function oneLine(value: string): string {
    return truncate(value.replace(LINE_BREAKS, ' ').trim(), COMMENT_PREVIEW_CHARS);
}

/** Files a hook recorded as evidence (`progress` with `{ files }`); empty for anything else. */
export function eventFiles(event: EventBody): string[] {
    if (event.kind !== 'progress') return [];
    const files = parsePayload(event.payload).files;
    return Array.isArray(files)
        ? files.filter((file): file is string => typeof file === 'string' && file.length > 0)
        : [];
}

function filesDetail(files: string[]): string {
    // win32.basename splits on both / and \, so a Windows path reads the same on any platform.
    const names = files.map(file => path.win32.basename(file));
    const more = names.length - FILES_NAMED;
    return `edited ${plural(names.length, 'file')}: ${names.slice(0, FILES_NAMED).join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}

/** The kind-specific words for one event: the timeline tool, standup and the dashboard all print these. */
export function eventDetail(event: EventBody): string {
    const payload = parsePayload(event.payload);
    switch (event.kind) {
        case 'created': {
            const phase = textField(payload, 'phase');
            return phase ? `created (${phase})` : 'created';
        }
        case 'phase': {
            const from = textField(payload, 'from');
            const to = textField(payload, 'to');
            if (from && to) return `${from} → ${to}`;
            return to ? `now ${to}` : 'phase changed';
        }
        case 'progress': {
            const files = eventFiles(event);
            if (files.length > 0) return filesDetail(files);
            const intent = textField(payload, 'intent');
            const note = textField(payload, 'note');
            if (intent && note) return `${intent}: ${oneLine(note)}`;
            return intent ?? (note ? oneLine(note) : 'progress');
        }
        case 'commit':
            return 'committed';
        case 'pr': {
            const url = textField(payload, 'url');
            return url ? `PR ${url}` : 'PR opened';
        }
        case 'comment': {
            const body = textField(payload, 'text');
            return body ? `comment: ${oneLine(body)}` : 'comment';
        }
        case 'renamed': {
            const to = textField(payload, 'to');
            return to ? `renamed to ${to}` : 'renamed';
        }
        case 'merged': {
            const into = taskIdField(payload, 'into');
            if (into !== null) return `merged into ${formatTaskId(into)}`;
            const from = taskIdField(payload, 'from');
            return from !== null ? `absorbed ${formatTaskId(from)}` : 'merged';
        }
        case 'linked': {
            // Two shapes: a link `{ vendor, remoteId, url }` and a broken one `{ vendor, remoteId, broken, reason }`.
            if (payload.broken === true) {
                const reason = textField(payload, 'reason');
                return reason ? `vendor item gone: ${oneLine(reason)}` : 'vendor item gone';
            }
            const url = textField(payload, 'url');
            return url ? `linked ${url}` : 'linked';
        }
        default:
            return event.kind;
    }
}

/** `T42 Login fix · `, or nothing for an event that belongs to no task. */
export function eventTask(entry: Pick<TimelineEntry, 'task_id' | 'title'>): string {
    return entry.task_id === null ? '' : `${formatTaskId(entry.task_id)} ${entry.title ?? ''} · `;
}

/** One timeline line: `- <at> · T42 <title> · <detail> (<source>)`. Titles, links and names are vendor text: cleaned, so it stays one line. */
export function renderEvent(entry: RenderableEvent): string {
    return cleanText(`- ${entry.at} · ${eventTask(entry)}${eventDetail(entry)} (${entry.source})`);
}
