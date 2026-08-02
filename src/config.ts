import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { findGitRoot } from './init';

export interface McpPmConfig {
    vendor: 'github' | 'azure_devops';
    workflow: {
        states: string[];
        transitions: Record<string, string>;
    };
    views: {
        list_columns: string[];
        detail_fields: string[];
    };
    notifications: Array<{
        name: string;
        condition: string;
    }>;
}

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
    const config = yaml.load(content) as McpPmConfig;
    
    return config;
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
