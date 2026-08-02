import { runCli } from '../src/cli';
import * as child_process from 'child_process';
import * as util from 'util';

jest.mock('child_process');
jest.mock('util', () => ({
    promisify: jest.fn((fn) => fn)
}));

describe('cli', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should execute command and return trimmed stdout', async () => {
        (child_process.execFile as unknown as jest.Mock).mockResolvedValue({ stdout: ' output  \n', stderr: '' });
        
        const result = await runCli('echo', ['hello']);
        expect(result).toBe('output');
        expect(child_process.execFile).toHaveBeenCalledWith('echo', ['hello'], expect.any(Object));
    });

    it('should warn if stderr is present but still return stdout', async () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        (child_process.execFile as unknown as jest.Mock).mockResolvedValue({ stdout: 'output', stderr: 'some warning' });
        
        const result = await runCli('echo', ['hello']);
        expect(result).toBe('output');
        expect(consoleWarnSpy).toHaveBeenCalledWith('[CLI Warn] some warning');
        consoleWarnSpy.mockRestore();
    });

    it('should throw and log error if command fails', async () => {
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const error = new Error('command failed');
        (child_process.execFile as unknown as jest.Mock).mockRejectedValue(error);
        
        await expect(runCli('failcmd', ['arg'])).rejects.toThrow('command failed');
        expect(consoleErrorSpy).toHaveBeenCalledWith('[CLI Error] Failed to execute: failcmd arg', error);
        consoleErrorSpy.mockRestore();
    });
});
