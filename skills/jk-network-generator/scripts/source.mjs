import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from './model.mjs';

/** Resolve the live canonical project without packaging another rule copy. */
export function resolveSource({ cwd = process.cwd(), root } = {}) {
  const defaults = JSON.parse(readFileSync(new URL('../references/source.json', import.meta.url), 'utf8'));
  let configName = defaults.config, via = 'skill source.json';
  if (!root) {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      const file = resolve(dir, 'JK_SOURCE.json');
      if (existsSync(file)) {
        const source = JSON.parse(readFileSync(file, 'utf8')).source;
        assert(source?.project === 'JK' && typeof source.root === 'string', 'Invalid JK_SOURCE.json');
        root = resolve(dir, source.root); configName = source.config; via = file; break;
      }
      if (dirname(dir) === dir) break;
    }
  } else via = '--root';
  root = resolve(root ?? defaults.root);
  const configPath = resolve(root, configName), config = JSON.parse(readFileSync(configPath, 'utf8'));
  const paths = Object.fromEntries(Object.entries(config.canonical).filter(([key]) => key !== 'project').map(([key, path]) => [key, resolve(root, path)]));
  const firstLine = readFileSync(paths.rules, 'utf8').split('\n')[0];
  assert(firstLine.match(/V\d+\.\d+\.\d+/)?.[0] === defaults.rule_version, `主源规则版本已变化：${firstLine}；先核对实现差异`);
  return { root, config: configPath, resolved_via: via, implementation_rule_version: defaults.rule_version, ...paths,
    documents: Object.fromEntries(Object.entries(config.documents).map(([key, path]) => [key, resolve(root, path)])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 0 || args.length === 2 && args[0] === '--root', 'Usage: node source.mjs [--root JK_PROJECT]');
    console.log(JSON.stringify(resolveSource({ root: args[1] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
