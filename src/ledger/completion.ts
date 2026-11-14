import { Ledger } from './db';
import { COMPLETION_REVIEW, CompletionMode, SETTING_COMPLETION, readSetting } from './settings';
import { getVendorLink } from './tasks';
import { AZURE_DEVOPS, CLOSED_PHASES, Phase, TaskRow, Vendor, formatTaskId } from './types';

/** Where verified work goes under `completion` review. Done stays a merged PR's, the vendor's or the user's call. */
export const VERIFIED_PHASE: Phase = 'in_review';
export const VERIFIED_PREFIX = 'Verified: ';

const VENDOR_NAMES: Partial<Record<Vendor, string>> = { github: 'GitHub', [AZURE_DEVOPS]: 'Azure DevOps' };

export const completionOf = (db: Ledger, task: TaskRow): CompletionMode => readSetting(db, task.workspace_id, SETTING_COMPLETION);

/** `GitHub #49`, or null when the task has no working vendor link. */
export function vendorRef(db: Ledger, task: TaskRow): { vendor: Vendor; ref: string; label: string } | null {
    const link = getVendorLink(db, task.id);
    if (link === undefined || link.broken_at !== null) return null;
    const name = VENDOR_NAMES[link.vendor];
    if (name === undefined) return null;
    const ref = `#${link.remote_id}`;
    return { vendor: link.vendor, ref, label: `${name} ${ref}` };
}

/**
 * Said with the session's active task on every prompt while completion is review (nothing under ask, which behaves as
 * 2.0 did): how Claude may move verified work on, and how its commits use the vendor's own linking and closing.
 */
export function completionGuidance(db: Ledger, task: TaskRow): string {
    if (completionOf(db, task) !== COMPLETION_REVIEW || CLOSED_PHASES.has(task.phase)) return '';
    const vendor = vendorRef(db, task);
    const parts = [
        `Completion: review. Once you have verified this work (tests or build run and passing) and committed it, call update_task `
        + `task_id=${formatTaskId(task.id)} verified="<what you ran and the result>"; it moves to ${VERIFIED_PHASE}. Never mark it done yourself.`,
    ];
    if (vendor?.vendor === 'github') {
        parts.push(`It is ${vendor.label}: end commit messages with "Refs ${vendor.ref}", and the final verified commit or PR description `
            + `with "Fixes ${vendor.ref}" (GitHub closes it when that reaches the default branch).`);
    } else if (vendor?.vendor === AZURE_DEVOPS) {
        parts.push(`It is ${vendor.label}: mention "${vendor.ref}" in commit messages to link them to the work item.`);
    }
    return parts.join(' ');
}

/** The prompt line for the session's attached task. */
export function activeLine(db: Ledger, task: TaskRow): string {
    const guidance = completionGuidance(db, task);
    return `Active: ${formatTaskId(task.id)} ${task.title} · ${task.phase}${guidance.length > 0 ? `\n${guidance}` : ''}`;
}

/** For get_project_state: the mode, and where the workspace's tasks get to by themselves. */
export function describeCompletion(db: Ledger, workspaceId: number): string {
    const mode = readSetting(db, workspaceId, SETTING_COMPLETION);
    return mode === COMPLETION_REVIEW
        ? `${mode} (Claude moves verified, committed work to ${VERIFIED_PHASE}; done comes from a merged PR, the vendor or you)`
        : `${mode} (Claude changes a phase only when you ask)`;
}
