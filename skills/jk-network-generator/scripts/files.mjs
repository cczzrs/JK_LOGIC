import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { assert } from './model.mjs';

function canonicalPath(path, seen = new Set()) {
  const absolute = resolve(path);
  assert(!seen.has(absolute), 'Output path contains a symlink cycle');
  seen.add(absolute);
  try {
    if (lstatSync(absolute).isSymbolicLink()) return canonicalPath(resolve(dirname(absolute), readlinkSync(absolute)), seen);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existsSync(absolute)) return realpathSync(absolute);
  // Resolve ancestors and dangling links before the generator creates either file.
  return resolve(canonicalPath(dirname(absolute), seen), basename(absolute));
}

export function assertSeparateFiles(sourcePath, outputPath) {
  const source = resolve(sourcePath), output = resolve(outputPath);
  assert(source !== output, 'Output path must not overwrite the model or specification');
  if (existsSync(source) && existsSync(output)) {
    const a = statSync(source), b = statSync(output);
    assert(a.dev !== b.dev || a.ino !== b.ino, 'Output path must not overwrite source (symlink or hardlink alias)');
  }
  assert(canonicalPath(source) !== canonicalPath(output), 'Output path must not overwrite source (resolved path alias)');
}
