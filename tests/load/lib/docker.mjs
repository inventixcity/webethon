import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const UNIT = { B: 1 / 1048576, KB: 1 / 1024, KiB: 1 / 1024, MB: 1, MiB: 1, GB: 1024, GiB: 1024 };

// Parses docker's "123.4MiB / 7.6GiB" into MiB. Returns null when docker or the container is unavailable,
// so a missing container (for example, the kind cluster) skips the memory check instead of failing it.
export async function containerMemory(container) {
  try {
    const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container], {
      timeout: 20_000,
      windowsHide: true,
    });
    const usage = stdout.trim().split('/')[0].trim();
    const match = usage.match(/^([\d.]+)\s*([A-Za-z]+)$/);
    if (!match || !(match[2] in UNIT)) return { error: `unrecognised docker memory value: ${usage}` };
    return { mib: Math.round(Number(match[1]) * UNIT[match[2]] * 10) / 10, raw: stdout.trim() };
  } catch (error) {
    return { error: String(error?.stderr || error?.message || error).trim().split('\n')[0] };
  }
}
