import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest, metrics } from '../skills/jk-network-generator/scripts/generate.mjs';
import { parseExpression } from '../skills/jk-network-generator/scripts/engine.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** Bind the delivered artifacts and compare metrics, without re-running tests. */
export function summarize(directory = join(root, 'artifacts/rgb-gray-3x3-shared')) {
  const dir = resolve(directory);
  const entries = [
    ['rgb-gray-216-72.shared.json', 'rgb-gray-216-72.shared.verification.json', 'rgb-gray-216-72.shared.truth-table.json'],
    ['rgb-gray-216-72.shared.modelshow.json', 'rgb-gray-216-72.shared.modelshow.verification.json', 'rgb-gray-216-72.shared.modelshow.truth-table.json'],
  ].map(([file, fifoFile, truthFile]) => {
    const model = readJson(join(dir, file));
    const fifo = readJson(join(dir, fifoFile));
    const truth = readJson(join(dir, truthFile));
    const auditFile = file.replace(/\.json$/, '.optimization.json');
    const audit = readJson(join(dir, auditFile));
    const previous = readJson(join(dir, 'baseline-ex', file));
    const modelHash = sha256(join(dir, file));
    assert.equal(model.md5, digest({ nodes: model.nodes, initial_q: model.initial_q, q_y: model.q_y, spec: model.spec }));
    for (const [key, value] of Object.entries(metrics(model.nodes))) assert.equal(model[key], value);
    assert.equal(fifo.passed, true); assert.equal(truth.status, 'passed');
    assert.equal(fifo.model_md5, model.md5); assert.equal(fifo.model_created_at, model.created_at);
    assert.equal(fifo.model_file_sha256, modelHash);
    assert.equal(fifo.engine_sha256, sha256(fifo.engine_path));
    assert.equal(fifo.verifier_sha256, sha256(join(root, 'scripts/verify-rgb-gray-shared.mjs')));
    assert.equal(fifo.metadata_helper_sha256, sha256(join(root, 'skills/jk-network-generator/scripts/generate.mjs')));
    assert.equal(fifo.nodes, 512); assert.equal(fifo.persistent_state_bits, 309);
    assert.ok(fifo.coverage.random_frames >= 10000);
    assert.equal(fifo.coverage.missing_one_bit_frames, 216);
    assert.equal(fifo.per_frame_node_executions, 2791);
    assert.equal(fifo.per_frame_operation_executions, 18073);
    assert.equal(fifo.startup_operation_executions, 4);
    assert.equal(model.ex_operation_sum, 2610);
    assert.equal(model.spec.optimization.preassembly_checks.passed, true);
    assert.equal(model.spec.optimization.preassembly_checks.phase, 'preassembly');
    assert.ok(model.spec.optimization.preassembly_checks.template_checks.length > 0);
    assert.equal(audit.passed, true);
    assert.equal(audit.coverage.audited_nodes, 512);
    assert.equal(audit.coverage.changed_nodes, 128);
    assert.equal(audit.coverage.after_stored_operations, model.ex_operation_sum);
    assert.equal(audit.coverage.before_stored_operations, previous.ex_operation_sum);
    assert.equal(audit.model_identity.md5, model.md5);
    assert.equal(audit.model_identity.created_at, model.created_at);
    assert.equal(audit.model_identity.file_sha256, modelHash);
    assert.equal(audit.baseline_identity.md5, previous.md5);
    assert.equal(audit.baseline_identity.file_sha256, sha256(join(dir, 'baseline-ex', file)));
    assert.equal(audit.auditor_identity.file_sha256, sha256(audit.auditor_identity.path));
    assert.equal(audit.engine_identity.file_sha256, sha256(audit.engine_identity.path));
    assert.equal(audit.global_optimum_proven, false);
    assert.equal(truth.model_identity.model_md5, model.md5);
    assert.equal(truth.model_identity.created_at, model.created_at);
    assert.equal(truth.model_identity.file_sha256, modelHash);
    assert.equal(truth.verifier_identity.file_sha256, sha256(truth.verifier_identity.path));
    assert.equal(truth.parser_engine_identity.file_sha256, sha256(truth.parser_engine_identity.path));
    assert.equal(truth.truth_table.rgb_combinations_passed, 16777216);
    assert.equal(truth.structure.arithmetic_core_instances, 1);
    assert.equal(truth.structure.arithmetic_nodes_per_core, 168);
    return { file, fifoFile, truthFile, auditFile, model, fifo, truth, audit, previous, modelHash };
  });

  const [named, numeric] = entries.map(entry => entry.model);
  const strip = id => id.replace(/L[1-9][RGB][0-7]$/, '');
  const remapEx = ex => parseExpression(ex).map(t => t.source ? `${t.op}(${strip(t.source)})` : `${t.op}${t.constant}`).join('');
  assert.deepEqual(named.nodes.map(n => ({ id: strip(n.id), ex: remapEx(n.ex) })), numeric.nodes);
  for (const bit of ['0', '1']) assert.deepEqual(named.initial_q[bit].map(strip), numeric.initial_q[bit]);
  for (const key of ['q_y', 'inputs', 'outputs', 'created_at']) assert.deepEqual(named[key], numeric[key]);
  assert.deepEqual(numeric.spec.storage_name_aliases, Object.fromEntries(named.spec.roles.storage.map(id => [strip(id), id])));

  const baselinePath = join(root, 'artifacts/rgb-gray-3x3/rgb-gray-216-72.json');
  const baseline = readJson(baselinePath);
  const baselineReportPath = join(root, 'artifacts/rgb-gray-3x3/rgb-gray-216-72.verification.json');
  const baselineReport = readJson(baselineReportPath);
  assert.equal(baselineReport.passed, true);
  assert.equal(baselineReport.model_file_sha256, sha256(baselinePath));
  assert.equal(baselineReport.model_md5, baseline.md5);
  assert.equal(baselineReport.model_created_at, baseline.created_at);
  const example = readJson(join(dir, 'example-run.json'));
  assert.equal(example.passed, true);
  assert.equal(example.model_md5, named.md5);
  assert.equal(example.model_created_at, named.created_at);
  assert.equal(example.model_file_sha256, entries[0].modelHash);
  const previousReport = readJson(join(dir, 'baseline-ex', entries[0].fifoFile));
  assert.equal(previousReport.passed, true);
  assert.equal(previousReport.model_file_sha256, sha256(join(dir, 'baseline-ex', entries[0].file)));
  const archiveManifest = readJson(join(dir, 'baseline-ex/archive-manifest.json'));
  for (const item of archiveManifest.files) assert.equal(sha256(join(dir, 'baseline-ex', item.name)), item.sha256);
  const modelshowEnginePath = resolve(root, '../ModelShow/src/engine.js');
  const modelshowEngineHash = existsSync(modelshowEnginePath) ? sha256(modelshowEnginePath) : null;
  if (modelshowEngineHash) assert.equal(modelshowEngineHash, entries[1].fifo.engine_sha256);

  const summary = {
    passed: true, verified_at: new Date().toISOString(),
    architecture_mode: 'shared', input_bits: 216, output_bits: 72,
    formula: named.spec.formula,
    compression: {
      parallel_nodes: baseline.jk_bits, shared_nodes: named.jk_bits,
      saved_nodes: baseline.jk_bits - named.jk_bits,
      reduction_percent: Number((100 * (baseline.jk_bits - named.jk_bits) / baseline.jk_bits).toFixed(4)),
      input_storage_bits: 216, shared_total_state_bits: 309,
      comparison: {
        persistent_state_bits: { parallel: 216, shared: 309 },
        stored_ex_operation_tokens: { parallel: baseline.ex_operation_sum, shared: named.ex_operation_sum },
        node_executions_per_frame: { parallel: baseline.jk_bits, shared: 2791 },
        jk_operations_per_frame: { parallel: baseline.ex_operation_sum, shared: 18073 },
        observed_peak_queue: { parallel: baselineReport.peak_queue, shared: entries[0].fifo.peak_queue },
      },
      comparison_boundary: 'Parallel metrics are from the retained baseline artifact/report; shared metrics come from the current reports. The shared run includes an additional cold-start schedule. Node count, stored expression length, runtime JK operations and queue length are distinct metrics; no hardware-area or runtime speedup is inferred.',
    },
    ex_optimization: {
      preassembly_checks: named.spec.optimization.preassembly_checks,
      audited_nodes: 512, changed_nodes: 128,
      before_stored_operations: entries[0].previous.ex_operation_sum,
      after_stored_operations: named.ex_operation_sum,
      before_operations_per_frame: previousReport.per_frame_operation_executions,
      after_operations_per_frame: entries[0].fifo.per_frame_operation_executions,
      before_startup_operations: previousReport.startup_operation_executions,
      after_startup_operations: entries[0].fifo.startup_operation_executions,
      proof_kinds: entries[0].audit.coverage.proof_kinds,
      graph_audit: entries[0].audit.graph_audit,
      core_exact_bfs_nodes: entries[0].audit.core_expression_audit.exact_bfs_nodes,
      core_lower_bound_nodes: entries[0].audit.core_expression_audit.source_lower_bound_nodes,
      core_minimum_not_proven: entries[0].audit.core_expression_audit.checked_but_minimum_not_proven_nodes,
      global_optimum_proven: false,
    },
    numeric_companion_exact_node_reference_renaming: true,
    models: entries.map(entry => ({
      file: entry.file, md5: entry.model.md5, created_at: entry.model.created_at,
      file_sha256: entry.modelHash, nodes: entry.model.jk_bits,
      fifo_report: entry.fifoFile, fifo_report_sha256: sha256(join(dir, entry.fifoFile)),
      truth_table_report: entry.truthFile, truth_table_report_sha256: sha256(join(dir, entry.truthFile)),
      optimization_report: entry.auditFile, optimization_report_sha256: sha256(join(dir, entry.auditFile)),
      engine_path: entry.fifo.engine_path, engine_sha256: entry.fifo.engine_sha256,
      completed_frames: entry.fifo.completed_frames, random_frames: entry.fifo.coverage.random_frames,
      unique_complete_input_vectors: entry.fifo.unique_complete_input_vectors,
      node_executions: entry.fifo.executions, jk_operation_executions: entry.fifo.operation_executions,
      elapsed_seconds: entry.fifo.elapsed_seconds, peak_queue: entry.fifo.peak_queue,
      exhaustive_core_rgb_combinations: entry.truth.truth_table.rgb_combinations_passed,
    })),
    current_modelshow_engine: {
      path: modelshowEnginePath, sha256: modelshowEngineHash,
      matches_tested_numeric_engine: modelshowEngineHash === null ? null : true,
      browser_ui_tested: false,
    },
    output_protocol: named.spec.output_validity,
    idle_marking: named.spec.execution.idle_cache,
    termination_argument: entries[0].fifo.termination_argument,
    evidence_boundary: 'Exhaustive 24-bit shared-core arithmetic, plus actual FIFO checks of sampled 216-bit frames, exact finite token waves, saved input and conditional output state, reset/reload and specified idle caches. Not an enumeration of all 2^216 frame inputs or arbitrary state/event interleavings.',
  };
  writeFileSync(join(dir, 'verification-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.ok(process.argv.length <= 3, 'Usage: node scripts/summarize-rgb-gray-shared.mjs [ARTIFACT_DIRECTORY]');
    const summary = summarize(process.argv[2]);
    console.log(JSON.stringify({ passed: true, compression: summary.compression, models: summary.models }));
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
