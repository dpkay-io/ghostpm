import { Ledger, write } from './db';

export const SETTING_CREATE_BRANCH = 'create_branch';
export const SETTING_STALE_SESSION_MINUTES = 'stale_session_minutes';
export const SETTING_CURRENT_USER = 'current_user';
export const SETTING_ACTIVE_SPRINT = 'active_sprint';

type SettingsObject = Record<string, unknown>;

export function getSetting<T>(db: Ledger, key: string): T | undefined {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
}

export function setSetting(db: Ledger, key: string, value: unknown): void {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value));
}

function readWorkspaceSettings(db: Ledger, workspaceId: number): SettingsObject | undefined {
    const row = db.prepare('SELECT settings FROM workspaces WHERE id = ?').get(workspaceId) as { settings: string } | undefined;
    return row ? JSON.parse(row.settings) as SettingsObject : undefined;
}

export function getWorkspaceSetting<T>(db: Ledger, workspaceId: number, key: string): T | undefined {
    return readWorkspaceSettings(db, workspaceId)?.[key] as T | undefined;
}

/** Read-modify-write under an immediate lock. Passing undefined removes the key. */
export function setWorkspaceSetting(db: Ledger, workspaceId: number, key: string, value: unknown): void {
    write(db, () => {
        const settings = readWorkspaceSettings(db, workspaceId);
        if (!settings) throw new Error(`Workspace ${workspaceId} not found`);
        if (value === undefined) delete settings[key];
        else settings[key] = value;
        db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify(settings), workspaceId);
    });
}

/** Workspace override, then global setting, then fallback. */
export function resolveSetting<T>(db: Ledger, workspaceId: number | null, key: string, fallback: T): T {
    const scoped = workspaceId === null ? undefined : getWorkspaceSetting<T>(db, workspaceId, key);
    if (scoped !== undefined) return scoped;
    return getSetting<T>(db, key) ?? fallback;
}
