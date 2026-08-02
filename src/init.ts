#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { runCli } from './cli';

export function findGitRoot(currentPath: string = process.cwd()): string | null {
    let dir = path.resolve(currentPath);
    while (true) {
        const gitPath = path.join(dir, '.git');
        if (fs.existsSync(gitPath)) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

export function detectVendor(currentPath: string = process.cwd()): 'github' | 'azure_devops' | null {
    const gitRoot = findGitRoot(currentPath);
    if (!gitRoot) return null;
    
    let configContent = '';
    const gitPath = path.join(gitRoot, '.git');
    const stat = fs.statSync(gitPath);
    
    let configPath = path.join(gitPath, 'config');
    if (stat.isFile()) {
        const gitdirMatch = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s+(.+)/);
        if (gitdirMatch) {
            const realGitDir = path.resolve(gitRoot, gitdirMatch[1].trim());
            configPath = path.join(realGitDir, 'config');
        }
    }
    
    if (fs.existsSync(configPath)) {
        configContent = fs.readFileSync(configPath, 'utf8');
    } else {
        return null;
    }

    const urls = configContent.match(/^\s*url\s*=\s*(.+)$/gm) || [];
    for (const urlMatch of urls) {
        const url = urlMatch.split('=')[1].trim();
        if (url.includes('github.com')) {
            return 'github';
        } else if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) {
            return 'azure_devops';
        }
    }
    return null;
}

export async function sniffWorkflowStates(vendor: 'github' | 'azure_devops'): Promise<string[]> {
    const states = new Set<string>();
    
    if (vendor === 'github') {
        try {
            const output = await runCli('gh', ['issue', 'list', '--limit', '100', '--state', 'all', '--json', 'state,labels']);
            const issues = JSON.parse(output || '[]');
            issues.forEach((issue: any) => {
                if (issue.state) states.add(issue.state.toLowerCase());
                if (issue.labels) {
                    issue.labels.forEach((label: any) => {
                        const labelName = label.name.toLowerCase();
                        if (['in_progress', 'in_review', 'blocked', 'testing'].includes(labelName)) {
                            states.add(labelName);
                        }
                    });
                }
            });
        } catch (e) {
            console.warn('Failed to sniff GitHub states', e);
        }
        
        if (states.size === 0) {
            return ['open', 'in_progress', 'in_review', 'closed'];
        }
    } else if (vendor === 'azure_devops') {
        try {
            const wiql = "SELECT [System.State] FROM workitems";
            const output = await runCli('az', ['boards', 'query', '--wiql', wiql, '--top', '100']);
            const result = JSON.parse(output || '[]');
            const items = Array.isArray(result) ? result : (result.items || []);
            
            items.forEach((item: any) => {
                if (item.fields && item.fields['System.State']) {
                    states.add(item.fields['System.State'].toLowerCase());
                }
            });
        } catch (e) {
            console.warn('Failed to sniff Azure DevOps states', e);
        }
        
        if (states.size === 0) {
            return ['new', 'active', 'resolved', 'closed'];
        }
    }
    
    return Array.from(states);
}

export async function initMcpPm(currentPath: string = process.cwd()): Promise<void> {
    const gitRoot = findGitRoot(currentPath);
    if (!gitRoot) {
        throw new Error('Not a git repository. Cannot initialize MCP PM.');
    }
    
    const configPath = path.join(gitRoot, '.mcp-pm.yml');
    if (fs.existsSync(configPath)) {
        console.log('.mcp-pm.yml already exists.');
        return;
    }
    
    console.log('Detecting vendor...');
    const vendor = detectVendor(gitRoot);
    if (!vendor) {
        throw new Error('Could not detect vendor (GitHub or Azure DevOps) from .git/config.');
    }
    console.log(`Detected vendor: ${vendor}`);
    
    console.log('Sniffing workflow states...');
    const states = await sniffWorkflowStates(vendor);
    console.log(`Deduced states: ${states.join(', ')}`);
    
    const yamlConfig = `vendor: "${vendor}"
workflow:
  states: [${states.map(s => `"${s}"`).join(', ')}]
  transitions:
    start_task: "${states.includes('in_progress') ? 'in_progress' : states.includes('active') ? 'active' : states[1] || 'open'}"
    code_push: "${states.includes('in_review') ? 'in_review' : states.includes('resolved') ? 'resolved' : states[2] || 'closed'}"
views:
  list_columns: ["id", "state", "title", "assignee"]
  detail_fields: ["id", "title", "body", "comments"]
notifications:
  - name: "New Assignment"
    condition: "assignee == @me AND state == 'open'"
`;

    fs.writeFileSync(configPath, yamlConfig, 'utf8');
    console.log(`Created .mcp-pm.yml at ${configPath}`);
}

if (require.main === module) {
    initMcpPm().catch(e => {
        console.error(e.message);
        process.exit(1);
    });
}
