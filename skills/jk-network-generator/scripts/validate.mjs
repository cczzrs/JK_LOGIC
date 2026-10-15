import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileModel } from './model.mjs';
import { assertSeparateFiles } from './files.mjs';

export function validateSnapshot(raw) {
  const model = compileModel(raw);
  return { passed: true, scope: 'JKRD V4.0.0 structure, state, ports, DAG, FIFOS, statistics and both fingerprints; no function/event-oracle proof',
    model_md5: raw.md5, model_format_md5: raw.format_md5, nodes: model.nodes.length,
    stateful_nodes: model.nodes.filter(n => n.initial !== null).length,
    queued_tasks: Object.fromEntries(Object.entries(raw.FIFOS).map(([name, tasks]) => [name, tasks.length])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, report, ...extra] = process.argv.slice(2);
  let writable = false;
  try {
    if (!file || extra.length) throw new Error('Usage: node validate.mjs MODEL.json [REPORT.json]');
    if (report) { assertSeparateFiles(file, report); writable = true; }
    const result = validateSnapshot(JSON.parse(readFileSync(file, 'utf8')));
    if (writable) writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = { passed: false, scope: 'structure', error: error.message };
    if (writable) {
      try { writeFileSync(report, JSON.stringify(result, null, 2) + '\n'); }
      catch (e) { console.error(`Cannot write failure report: ${e.message}`); }
    }
    console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
