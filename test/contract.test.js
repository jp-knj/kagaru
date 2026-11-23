import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { applyEdits } from 'kagaru';

const source = 'export default { server: { port: 3000 }, plugins: [] };';

function fails(result, code, operationIndex = 0) {
	assert.equal(result.ok, false);
	assert.equal(result.error.code, code);
	assert.equal(result.error.operationIndex, operationIndex);
	assert.equal('code' in result, false);
}

test('requires a precondition for every operation', () => {
	for (const operation of [
		{ op: 'set', path: ['server', 'port'], value: 3001 },
		{ op: 'append', path: ['plugins'], value: 1 },
		{ op: 'addImport', from: 'pkg', local: 'plugin' },
	])
		fails(applyEdits(source, [operation]), 'INVALID_INPUT');
});

test('checks the declared value and distinguishes missing from null', () => {
	const edit = { op: 'set', path: ['server', 'port'], expect: { value: 3000 }, value: 3001 };
	assert.equal(applyEdits(source, [edit]).ok, true);
	fails(applyEdits(source.replace('3000', '9000'), [edit]), 'PRECONDITION_FAILED');
	fails(applyEdits(source, [{ ...edit, path: ['server', 'prot'] }]), 'PRECONDITION_FAILED');
	fails(
		applyEdits('export default { value: null };', [
			{ op: 'set', path: ['value'], expect: { missing: true }, value: 1 },
		]),
		'PRECONDITION_FAILED',
	);
	assert.equal(
		applyEdits('export default { value: null };', [
			{ op: 'set', path: ['value'], expect: { value: null }, value: 1 },
		]).ok,
		true,
	);
});

test('checks array contents and rejects retries and stale instructions identically', () => {
	const edits = [
		{ op: 'append', path: ['plugins'], expect: { value: [] }, expression: 'plugin()' },
	];
	const first = applyEdits(source, edits);
	assert.equal(first.ok, true);
	fails(applyEdits(first.code, edits), 'PRECONDITION_FAILED');
	fails(applyEdits(source.replace('[]', '[other()]'), edits), 'PRECONDITION_FAILED');
	fails(applyEdits(source, [...edits, ...edits]), 'PRECONDITION_FAILED', 1);
	const second = applyEdits(first.code, [
		{ ...edits[0], expect: { expression: '[ plugin( /* keep */ ) ]' } },
	]);
	assert.equal(second.ok, true);
});

test('checks preconditions against the state immediately before each operation', () => {
	const edits = [
		{ op: 'set', path: ['server', 'port'], expect: { value: 3000 }, value: 3001 },
		{ op: 'set', path: ['server', 'port'], expect: { value: 3001 }, value: 3002 },
	];
	assert.equal(applyEdits(source, edits).ok, true);
	fails(
		applyEdits(source, [edits[0], { ...edits[1], expect: { value: 3000 } }]),
		'PRECONDITION_FAILED',
		1,
	);
});

test('preserves JSON own keys and negative zero at every nesting level', () => {
	const value = JSON.parse('{"__proto__":{"enabled":true},"nested":[{"__proto__":null},-0]}');
	const result = applyEdits('export default {};', [
		{ op: 'set', path: ['value'], expect: { missing: true }, value },
	]);
	assert.equal(result.ok, true);
	const actual = runInNewContext(
		result.code.replace('export default ', 'globalThis.config = ') + '\nconfig.value',
	);
	assert.equal(Object.hasOwn(actual, '__proto__'), true);
	assert.equal(actual.__proto__.enabled, true);
	assert.equal(Object.hasOwn(actual.nested[0], '__proto__'), true);
	assert.equal(Object.is(actual.nested[1], -0), true);
	assert.equal(actual.enabled, undefined);
	assert.equal(
		applyEdits(result.code, [{ op: 'set', path: ['value'], expect: { value }, value: null }]).ok,
		true,
	);
});

test('treats __proto__ in a path as an own data property', () => {
	const result = applyEdits('export default {};', [
		{ op: 'set', path: ['__proto__', '__proto__'], expect: { missing: true }, value: -0 },
		{ op: 'set', path: ['__proto__', '__proto__'], expect: { value: -0 }, value: 1 },
	]);
	assert.equal(result.ok, true);
	const actual = runInNewContext(
		result.code.replace('export default ', 'globalThis.config = ') + '\nconfig',
	);
	assert.equal(Object.hasOwn(actual, '__proto__'), true);
	assert.equal(Object.hasOwn(actual.__proto__, '__proto__'), true);
	assert.equal(actual.__proto__.__proto__, 1);
});

test('refuses unreadable JSON and ambiguous targets without evaluating them', () => {
	for (const input of [
		'export default { value: unknown() };',
		'export default { value: { __proto__: null } };',
		'export default { value: { ...base } };',
		'export default { value: [1,,] };',
	])
		fails(
			applyEdits(input, [{ op: 'set', path: ['value'], expect: { value: {} }, value: 1 }]),
			'PRECONDITION_FAILED',
		);
	for (const input of [
		'const shared = {}; export default { server: shared, preview: shared };',
		'export default { server: { [key]: 1 } };',
	])
		fails(
			applyEdits(input, [
				{ op: 'set', path: ['server', 'port'], expect: { missing: true }, value: 1 },
			]),
			'EDIT_FAILED',
		);
});

test('checks import absence including destructuring, hoisted var and type declarations', () => {
	const edit = { op: 'addImport', from: 'pkg', local: 'plugin', expect: { missing: true } };
	for (const declaration of [
		'import plugin from "pkg";',
		'const { nested: [plugin] } = value;',
		'if (true) { var plugin; }',
		'export function plugin() {}',
		'type plugin = {};',
		'namespace plugin {}',
		'import type plugin from "pkg";',
	])
		fails(
			applyEdits(`${declaration} export default {};`, [edit], { language: 'ts' }),
			'PRECONDITION_FAILED',
		);
	assert.equal(applyEdits('function f(plugin) {} export default {};', [edit]).ok, true);
});

test('checks exact import bindings and supports explicit no-op expectations', () => {
	const input = 'import { default as plugin } from "pkg"; export default {};';
	const edit = {
		op: 'addImport',
		from: 'pkg',
		local: 'plugin',
		expect: { from: 'pkg', imported: 'default', kind: 'value' },
	};
	assert.deepEqual(applyEdits(input, [edit]), { ok: true, code: input, changed: false });
	fails(
		applyEdits(input, [{ ...edit, expect: { ...edit.expect, kind: 'type' } }]),
		'PRECONDITION_FAILED',
	);
	fails(
		applyEdits(input, [{ ...edit, expect: { ...edit.expect, from: 'other' } }]),
		'PRECONDITION_FAILED',
	);
});

test('does not execute expected expressions and does not claim application validity', () => {
	const input = 'throw new Error("never run"); export default { value: dangerous() };';
	assert.equal(
		applyEdits(input, [
			{
				op: 'set',
				path: ['value'],
				expect: { expression: 'dangerous()' },
				expression: 'alsoDangerous()',
			},
			{ op: 'set', path: ['prot'], expect: { missing: true }, value: 3001 },
		]).ok,
		true,
	);
	fails(
		applyEdits(input, [
			{ op: 'set', path: ['value'], expect: { expression: 'const x = 1' }, value: 1 },
		]),
		'INVALID_EXPRESSION',
	);
});
