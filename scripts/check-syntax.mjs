// node --check every shipped JS module (screen.js + src/**), so a syntax
// error fails CI even in a file no unit test imports.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = ['screen.js'];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js')) files.push(p);
    }
})('src');
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log('node --check: ' + files.length + ' files OK');
