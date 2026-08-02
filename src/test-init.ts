import { initMcpPm } from './init';
import { loadConfig } from './config';
import * as path from 'path';

async function main() {
    try {
        console.log("Testing initialization...");
        await initMcpPm(path.join(process.cwd(), 'src'));
        console.log("Init finished.");
        
        console.log("Testing config load...");
        const config = loadConfig(path.join(process.cwd(), 'src'));
        console.log(JSON.stringify(config, null, 2));
    } catch (e) {
        console.error("Test failed", e);
    }
}

main();
