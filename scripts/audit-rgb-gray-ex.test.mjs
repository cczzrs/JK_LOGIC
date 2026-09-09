import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditModels, auditRgbGrayEx, auditPrimitiveExpressions, proveFullAdderNodeLowerBound, proveJKExpression } from './audit-rgb-gray-ex.mjs';
import { parseExpression } from '../skills/jk-network-generator/scripts/engine.mjs';

assert.ok(process.argv.length === 2 || process.argv.length === 4, 'Usage: node scripts/audit-rgb-gray-ex.test.mjs [BASELINE MODEL]');
const fixtureDir = fileURLToPath(new URL('../artifacts/rgb-gray-3x3-shared/', import.meta.url));
const baseline = JSON.parse(readFileSync(resolve(process.argv[2] ?? join(fixtureDir, 'baseline-ex/rgb-gray-216-72.shared.json'))));
const model = JSON.parse(readFileSync(resolve(process.argv[3] ?? join(fixtureDir, 'rgb-gray-216-72.shared.json'))));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = raw => createHash('md5').update(canonical({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec: raw.spec })).digest('hex');
function refresh(raw) {
  const tokens = raw.nodes.map(node => parseExpression(node.ex));
  raw.jk_bits = raw.jk_bits_max = raw.nodes.length;
  raw.ex_operation_sum = tokens.reduce((sum, ts) => sum + ts.length, 0);
  raw.ex_operation_max = Math.max(...tokens.map(ts => ts.length));
  raw.ex_source_sum = tokens.reduce((sum, ts) => sum + ts.filter(token => token.source).length, 0);
  raw.ex_source_max = Math.max(...tokens.map(ts => new Set(ts.filter(token => token.source).map(token => token.source)).size));
  raw.md5 = digest(raw);
}
const baselineBefore = JSON.stringify(baseline), modelBefore = JSON.stringify(model);
const positive = auditModels(baseline, model);
assert.equal(positive.passed, true, positive.error?.message);
assert.deepEqual(positive.coverage, {
  total_nodes: 512, audited_nodes: 512, changed_nodes: 128, unchanged_nodes: 384,
  before_stored_operations: 2887, after_stored_operations: 2610,
  proof_kinds: { identical_expression: 384, unconditional_equivalence: 98, initialization_once_invariant: 1,
    controller_constant_one_invariant: 20, selector_reachable_state_invariant: 9 },
});
assert.equal(JSON.stringify(baseline), baselineBefore); assert.equal(JSON.stringify(model), modelBefore);
assert.equal(positive.core_expression_audit.exact_bfs_nodes, 141);
assert.equal(positive.core_expression_audit.source_lower_bound_nodes, 8);
assert.equal(positive.core_expression_audit.checked_but_minimum_not_proven_nodes.length, 19);
assert.equal(positive.invariant_proofs.selector.orbit_length, 9);
assert.equal(positive.invariant_proofs.selector.local_transition_checks, 81);
assert.equal(positive.global_optimum_proven, false);

const failures = [];
function reject(name, mutate, fix = true) {
  const changed = structuredClone(model);
  mutate(changed);
  if (fix) refresh(changed);
  const result = auditModels(baseline, changed);
  assert.equal(result.passed, false, `${name} was accepted`);
  assert.ok(result.error?.message, `${name} has no diagnostic`);
  failures.push({ name, error: result.error.message });
}
const find = (raw, id) => raw.nodes.find(node => node.id === id);
reject('removed_stateful_self_source', raw => { find(raw, raw.spec.roles.output_state[0]).ex = parseExpression(find(raw, raw.spec.roles.output_state[0]).ex).slice(1).map(token => token.text).join(''); });
reject('changed_state_classification', raw => raw.initial_q['0'].push(raw.spec.roles.core[0]));
reject('wrong_bootstrap', raw => { find(raw, raw.spec.roles.bootstrap).ex = 'K0'; });
reject('wrong_clock_constant', raw => { find(raw, raw.spec.roles.clock).ex += 'K1'; });
reject('wrong_selector_orbit', raw => { find(raw, raw.spec.roles.selector_wrap).ex = find(raw, raw.spec.roles.selector_wrap).ex.replace('K(', 'J('); });
reject('wrong_output_value', raw => { find(raw, raw.spec.roles.output_state[10]).ex += 'K1'; });
reject('wrong_core_value', raw => { find(raw, raw.spec.roles.core_outputs[0]).ex += 'K1'; });
reject('false_role_metadata', raw => { [raw.spec.roles.merges[0], raw.spec.roles.merges[1]] = [raw.spec.roles.merges[1], raw.spec.roles.merges[0]]; });
reject('changed_output_mapping', raw => { raw.q_y[0] = { Y0: raw.spec.roles.output_state[1] }; });
reject('missed_known_output_optimization', raw => { find(raw, raw.spec.roles.output_state[0]).ex = find(baseline, raw.spec.roles.output_state[0]).ex; });
reject('spoofed_operation_count', raw => { raw.ex_operation_sum++; }, false);
reject('invalid_digest', raw => { raw.md5 = 'invalid'; }, false);
assert.equal(auditModels(baseline, baseline).passed, false, 'An unoptimized model must not satisfy the mandatory optimization gate');

const bootstrap = model.spec.roles.bootstrap;
assert.equal(proveJKExpression({ id: bootstrap, beforeEx: 'J0K1', afterEx: 'K1', stateful: true }).equivalent, false);
assert.equal(proveJKExpression({ id: bootstrap, beforeEx: 'J0K1', afterEx: 'K1', stateful: true, knownValues: { [bootstrap]: 0 } }).equivalent, true);
const firstOutput = model.spec.roles.output_state[0];
const primitive = auditPrimitiveExpressions({ name: 'first conditional output', nodes: [find(model, firstOutput)], initial_q: model.initial_q });
assert.equal(primitive.node_audits[0].local_minimum.minimum_operations, 4);
assert.equal(proveFullAdderNodeLowerBound().minimum_nodes_for_two_separate_sum_carry_publications, 3);

const temp = mkdtempSync('/private/tmp/jk-ex-audit-selftest-'), baselineFile = join(temp, 'baseline.json'), modelFile = join(temp, 'model.json');
writeFileSync(baselineFile, JSON.stringify(baseline)); writeFileSync(modelFile, JSON.stringify(model));
const fileReport = auditRgbGrayEx(baselineFile, modelFile, join(temp, 'passed.json'));
assert.equal(fileReport.passed, true); assert.ok(fileReport.model_identity.file_sha256 && fileReport.auditor_identity.file_sha256);
for (const [label, input] of [['baseline', baselineFile], ['model', modelFile]]) {
  const original = readFileSync(input);
  assert.throws(() => auditRgbGrayEx(baselineFile, modelFile, input));
  const symlink = join(temp, `${label}-symlink.json`), hardlink = join(temp, `${label}-hardlink.json`);
  symlinkSync(input, symlink); linkSync(input, hardlink);
  assert.throws(() => auditRgbGrayEx(baselineFile, modelFile, symlink));
  assert.throws(() => auditRgbGrayEx(baselineFile, modelFile, hardlink));
  assert.deepEqual(readFileSync(input), original);
}
const corrupt = structuredClone(model); corrupt.md5 = 'bad'; const corruptFile = join(temp, 'corrupt.json');
writeFileSync(corruptFile, JSON.stringify(corrupt));
const failureReport = auditRgbGrayEx(baselineFile, corruptFile, join(temp, 'failed.json'));
assert.equal(failureReport.passed, false); assert.ok(failureReport.error.message);
console.log(JSON.stringify({ passed: true, coverage: positive.coverage, mutation_rejections: failures.length,
  file_alias_rejections: 6, temporary_directory: temp, rejection_diagnostics: failures }, null, 2));
