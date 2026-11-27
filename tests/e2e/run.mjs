import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const files = (await readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort();
const results = [];
for (const file of files) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', join(directory, file)], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  results.push({ file, result: code === 0 ? 'PASS' : 'FAIL' });
}
console.log('\nSuite results');
console.table(results);
if (results.some(result => result.result === 'FAIL')) process.exitCode = 1;
