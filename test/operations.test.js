import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdits } from 'kagaru';

const source = 'export default { server: { port: 3000 }, plugins: [] };';

function assertFailure(result, code, operationIndex) {
	assert.equal(result.ok, false);
	assert.equal(result.error.code, code);
	assert.equal(result.error.operationIndex, operationIndex);
	assert.equal(typeof result.error.message, 'string');
	assert.ok(result.error.message.length > 0);
	assert.deepEqual(Object.keys(result), ['ok', 'error']);
}

test('applies JSON operations synchronously and in order', () => {
	const operations = JSON.parse(`[
		{"op":"addImport","expect":{"missing":true},"from":"@vitejs/plugin-react","local":"react"},
		{"op":"append","expect":{"value":[]},"path":["plugins"],"expression":"react()"},
		{"op":"set","expect":{"value":3000},"path":["server","port"],"value":3001}
	]`);
	const result = applyEdits(source, operations);
	assert.deepEqual(result, {
		ok: true,
		code: 'import react from "@vitejs/plugin-react";\nexport default { server: { port: 3001 }, plugins: [react()] };',
		changed: true,
	});
	assert.equal(operations[2].value, 3001);
});

test('reports changed from the final source, including empty and duplicate edits', () => {
	assert.deepEqual(applyEdits(source, []), { ok: true, code: source, changed: false });
	assert.deepEqual(
		applyEdits(source, [
			{ op: 'set', expect: { value: 3000 }, path: ['server', 'port'], value: 3001 },
			{ op: 'set', expect: { value: 3001 }, path: ['server', 'port'], value: 3000 },
		]),
		{ ok: true, code: source, changed: false },
	);
	const imported = 'import plugin from "pkg"; ' + source;
	assert.deepEqual(
		applyEdits(imported, [
			{
				op: 'addImport',
				expect: { from: 'pkg', imported: 'default', kind: 'value' },
				from: 'pkg',
				local: 'plugin',
			},
		]),
		{
			ok: true,
			code: imported,
			changed: false,
		},
	);
});

test('returns no partial code when a later operation fails', () => {
	for (const [operation, code] of [
		[{ op: 'append', expect: { value: 3001 }, path: ['server', 'port'], value: 1 }, 'EDIT_FAILED'],
		[
			{ op: 'set', expect: { missing: true }, path: ['value'], expression: 'const broken = 1' },
			'INVALID_EXPRESSION',
		],
		[{ op: 'remove', path: ['server'] }, 'INVALID_INPUT'],
	]) {
		assertFailure(
			applyEdits(source, [
				{ op: 'set', expect: { value: 3000 }, path: ['server', 'port'], value: 3001 },
				operation,
			]),
			code,
			1,
		);
	}
});

test('rejects invalid source separately from invalid input', () => {
	for (const input of [
		'export default {',
		'export default {} satisfies Config;',
		'export default <div />;',
	]) {
		assertFailure(applyEdits(input, []), 'INVALID_SOURCE', null);
	}
	assertFailure(
		applyEdits('export default { port: ; };', [], { language: 'ts' }),
		'INVALID_SOURCE',
		null,
	);
	for (const input of [null, 1, {}, new String(source)]) {
		assertFailure(applyEdits(input, []), 'INVALID_INPUT', null);
	}
	for (const operations of [null, {}, '[]', [, ,]]) {
		assertFailure(applyEdits(source, operations), 'INVALID_INPUT', null);
	}
	for (const options of [
		null,
		'ts',
		[],
		{ language: 'tsx' },
		{ language: null },
		{ extra: true },
	]) {
		assertFailure(applyEdits(source, [], options), 'INVALID_INPUT', null);
	}
});

test('rejects unknown operations, malformed paths and extra fields', () => {
	for (const operation of [
		null,
		[],
		{},
		{ op: 'delete' },
		{ op: 'set', expect: { missing: true }, path: [], value: 1 },
		{ op: 'set', expect: { missing: true }, path: 'port', value: 1 },
		{ op: 'set', expect: { missing: true }, path: ['server', 0], value: 1 },
		{ op: 'set', expect: { missing: true }, path: new Array(1), value: 1 },
		{ op: 'set', expect: { missing: true }, path: ['port'] },
		{ op: 'set', expect: { missing: true }, path: ['port'], value: 1, expression: '1' },
		{ op: 'set', expect: { missing: true }, path: ['port'], expression: 1 },
		{ op: 'append', expect: { value: [] }, path: ['plugins'], value: 1, extra: true },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg' },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'plugin', path: [] },
		{ op: 'addImport', expect: { missing: true }, from: 1, local: 'plugin' },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'plugin', imported: null },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: '' },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'a, {b}' },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'await' },
	]) {
		assertFailure(applyEdits(source, [operation]), 'INVALID_INPUT', 0);
	}
});

test('rejects values that cannot be represented faithfully as JSON', () => {
	const cyclic = {};
	cyclic.self = cyclic;
	let getterCalled = false;
	const accessor = {
		get value() {
			getterCalled = true;
			return 1;
		},
	};
	for (const value of [
		undefined,
		NaN,
		Infinity,
		-Infinity,
		1n,
		Symbol('value'),
		() => 1,
		new Date(),
		new Map(),
		new Set(),
		/value/,
		new Number(1),
		cyclic,
		{ nested: undefined },
		{ nested: [NaN] },
		[undefined],
		new Array(1),
		{
			toJSON() {
				throw new Error('Must not run');
			},
		},
		accessor,
		{ [Symbol('extra')]: 1 },
		Object.defineProperty({}, 'hidden', { value: 1 }),
		Object.assign([], { extra: true }),
		new (class extends Array {
			toJSON() {
				throw new Error('Must not run');
			}
		})(),
	]) {
		assertFailure(
			applyEdits(source, [{ op: 'set', expect: { missing: true }, path: ['value'], value }]),
			'INVALID_INPUT',
			0,
		);
	}
	assert.equal(getterCalled, false);
});

test('accepts JSON primitives, nested data, shared values and literal property names', () => {
	const shared = { nested: [true, null, 1, 'text'] };
	const value = { first: shared, second: shared };
	const result = applyEdits('export default {};', [
		{ op: 'set', expect: { missing: true }, path: ['a.b', ''], value },
	]);
	assert.equal(result.ok, true);
	assert.equal(result.code, `export default {"a.b": {"": ${JSON.stringify(value)}}};`);
});

test('validates expressions as single expressions and preserves their text', () => {
	for (const expression of ['', 'const a = 1', 'one); run(); (two', '1; 2']) {
		assertFailure(
			applyEdits(source, [{ op: 'append', expect: { value: [] }, path: ['plugins'], expression }]),
			'INVALID_EXPRESSION',
			0,
		);
	}
	for (const expression of ['plugin()', '1, 2', '1 // trailing comment', '({ nested: true })']) {
		const result = applyEdits(source, [
			{ op: 'append', expect: { value: [] }, path: ['plugins'], expression },
		]);
		assert.equal(result.ok, true);
		assert.ok(result.code.includes(expression));
	}
});

test('does not execute source or expression code or load imported modules', () => {
	const result = applyEdits(
		'throw new Error("Never execute"); export default {} satisfies Config;',
		[
			{ op: 'addImport', expect: { missing: true }, from: 'nonexistent-package', local: 'plugin' },
			{
				op: 'set',
				expect: { missing: true },
				path: ['value'],
				expression: '(() => { throw new Error("Never execute"); })()',
			},
		],
		{ language: 'ts' },
	);
	assert.equal(result.ok, true);
	assert.match(result.code, /nonexistent-package/);
	assert.match(result.code, /throw new Error/);
});

test('rejects targets outside the literal editing scope', () => {
	for (const source of [
		'const config = {}; export default config;',
		'export default () => ({});',
		'module.exports = {};',
		'export default { ...base };',
		'export default { plugins: [...base] };',
		'export default { plugins: [1,,] };',
		'export default { plugins: [] } satisfies Config;',
	]) {
		const expect = source.includes('[...base]')
			? { expression: '[...base]' }
			: source.includes('[1,,]')
				? { expression: '[1,,]' }
				: { missing: true };
		const result = applyEdits(source, [{ op: 'append', expect, path: ['plugins'], value: 1 }]);
		assertFailure(
			result,
			source.includes('satisfies') ? 'INVALID_SOURCE' : 'EDIT_FAILED',
			source.includes('satisfies') ? null : 0,
		);
	}
});

test('reports import precondition failures at the failing operation', () => {
	assertFailure(
		applyEdits(source, [
			{ op: 'addImport', expect: { missing: true }, from: 'first', local: 'plugin' },
			{ op: 'addImport', expect: { missing: true }, from: 'second', local: 'plugin' },
		]),
		'PRECONDITION_FAILED',
		1,
	);
});
