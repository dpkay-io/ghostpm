import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { findGitRoot } from './init';

const configSchema = z.object({
    vendor: z.enum(['github', 'azure_devops']),
    workflow: z.object({
        states: z.array(z.string()),
        transitions: z.record(z.string(), z.string()),
    }),
    views: z.object({
        list_columns: z.array(z.string()),
        detail_fields: z.array(z.string()),
    }),
    notifications: z.array(z.object({
        name: z.string(),
        condition: z.string(),
    })).default([]),
});

export type McpPmConfig = z.infer<typeof configSchema>;

export function loadConfig(currentPath: string = process.cwd()): McpPmConfig {
    const gitRoot = findGitRoot(currentPath);
    if (!gitRoot) {
        throw new Error('Not a git repository. Cannot load configuration.');
    }

    const configPath = path.join(gitRoot, '.mcp-pm.yml');
    if (!fs.existsSync(configPath)) {
        throw new Error(`.mcp-pm.yml not found at ${configPath}. Please run init first.`);
    }

    const content = fs.readFileSync(configPath, 'utf8');
    const raw = yaml.load(content);
    const result = configSchema.safeParse(raw);
    if (!result.success) {
        throw new Error(`.mcp-pm.yml is invalid: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`);
    }
    return result.data;
}

// Config parser that translates generic states (e.g., "in_progress") to vendor-specific flags.
export function translateState(state: string, config: McpPmConfig): string {
    // If it's a known transition state, resolve it
    if (config.workflow.transitions[state]) {
        return config.workflow.transitions[state];
    }
    
    // Otherwise return as is, assuming it's already a target state
    // Vendor adapters can do further specific logic based on their workflow
    return state;
}
