import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The version in package.json, found by walking up from this file: it is src/cli/ when run from source and dist/
// when installed, and package.json sits at a different depth in each.
export function readVersion(from = dirname(fileURLToPath(import.meta.url))) {
    const file = join(from, 'package.json');
    try {
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        if (manifest.name === 'agent-idea' && manifest.version)
            return manifest.version;
    }
    catch {
        // No package.json here; keep climbing.
    }
    const parent = dirname(from);
    if (parent === from)
        throw new Error('Cannot find the version: no package.json for agent-idea.');
    return readVersion(parent);
}
