import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows and macOS ignore filename case; the Linux production image does not. An import
// like "../utils/HttpError.js" for a file named httpError.js passes every test and local run
// on a developer machine, then crashes the API on startup in production (this happened once:
// the container crash-looped with ERR_MODULE_NOT_FOUND). This test resolves every relative
// import against the exact case on disk, so that mistake fails here instead.

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'models'];
const SOURCE_EXT = /\.(js|mjs)$/;
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;

function listSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(full));
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

// True only if every path segment matches an on-disk name exactly (case included).
function existsExactCase(target) {
  const parts = path.relative(path.parse(target).root, target).split(path.sep);
  let current = path.parse(target).root;
  for (const part of parts) {
    if (!fs.existsSync(current) || !fs.readdirSync(current).includes(part)) return false;
    current = path.join(current, part);
  }
  return true;
}

describe('relative imports match file names exactly (case-sensitive filesystems)', () => {
  it('has no import whose casing differs from the file on disk', () => {
    const bad = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listSources(path.join(apiRoot, dir))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const match of text.matchAll(SPECIFIER)) {
          const resolved = path.resolve(path.dirname(file), match[2]);
          if (!existsExactCase(resolved)) {
            bad.push(`${path.relative(apiRoot, file)} imports ${match[2]}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
