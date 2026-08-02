import { loadConfig, translateState, McpPmConfig } from '../src/config';
import * as fs from 'fs';
import * as init from '../src/init';
import * as path from 'path';

jest.mock('fs');
jest.mock('../src/init');

describe('config', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('loadConfig', () => {
        it('should throw if not in a git repository', () => {
            (init.findGitRoot as jest.Mock).mockReturnValue(null);
            expect(() => loadConfig('/some/path')).toThrow('Not a git repository. Cannot load configuration.');
        });

        it('should throw if .mcp-pm.yml not found', () => {
            (init.findGitRoot as jest.Mock).mockReturnValue('/git/root');
            (fs.existsSync as jest.Mock).mockReturnValue(false);
            const expectedPath = path.join('/git/root', '.mcp-pm.yml');
            expect(() => loadConfig('/git/root')).toThrow(`.mcp-pm.yml not found at ${expectedPath}. Please run init first.`);
        });

        it('should load and parse the configuration file', () => {
            const mockConfig = `
vendor: github
workflow:
  states: [open, in_progress, closed]
  transitions:
    start_task: in_progress
views:
  list_columns: [id, title]
  detail_fields: [id, title, body]
notifications: []
`;
            (init.findGitRoot as jest.Mock).mockReturnValue('/git/root');
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readFileSync as jest.Mock).mockReturnValue(mockConfig);

            const config = loadConfig('/git/root');
            expect(config.vendor).toBe('github');
            expect(config.workflow.states).toEqual(['open', 'in_progress', 'closed']);
        });
    });

    describe('translateState', () => {
        const mockConfig: McpPmConfig = {
            vendor: 'github',
            workflow: {
                states: ['open', 'in_progress', 'closed'],
                transitions: {
                    start_task: 'in_progress'
                }
            },
            views: {
                list_columns: [],
                detail_fields: []
            },
            notifications: []
        };

        it('should translate state if found in transitions', () => {
            expect(translateState('start_task', mockConfig)).toBe('in_progress');
        });

        it('should return the original state if not found in transitions', () => {
            expect(translateState('closed', mockConfig)).toBe('closed');
        });
    });
});
