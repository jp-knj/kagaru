import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Parser } from 'acorn';
import { tsPlugin } from '@sveltejs/acorn-typescript';
import { applyEdits } from 'kagaru';
import { verifyEdit } from '../src/verification.js';

const parser = Parser.extend(tsPlugin({ jsx: false }));
function snapshot(source) {
	const comments = [];
	return {
		source,
		comments,
		ast: parser.parse(source, {
			ecmaVersion: 'latest',
			sourceType: 'module',
			preserveParens: true,
			locations: true,
			onComment: comments,
		}),
	};
}

function verify(source, operation, result) {
	const expression =
		operation.expression === undefined
			? undefined
			: snapshot(`(\n${operation.expression}\n)`).ast.body[0].expression.expression;
	verifyEdit(snapshot(source), operation, snapshot(result), expression);
}

test('rejects wrong values independently of the writer', () => {
	for (const [value, output] of [
		[3001, '3002'],
		[-0, '0'],
		[JSON.parse('{"__proto__":null}'), '{"__proto__":null}'],
		[{ nested: [true] }, '{ nested: [false] }'],
		[{ nested: 1 }, '{ nested: 1, extra: 2 }'],
	])
		assert.throws(() =>
			verify(
				'export default { value: 1 };',
				{ op: 'set', path: ['value'], value },
				`export default { value: ${output} };`,
			),
		);
});

test('rejects collateral changes even when the requested value is correct', () => {
	const source = 'const keep = 1; export default { value: 1, /* keep */ other: 2 };';
	const operation = { op: 'set', path: ['value'], value: 3 };
	const good = source.replace('value: 1', 'value: 3');
	assert.doesNotThrow(() => verify(source, operation, good));
	for (const bad of [
		good.replace('keep = 1', 'keep = 2'),
		good.replace('other: 2', 'other: 3'),
		good.replace('/* keep */', '/* changed */'),
		good.replace('other:', 'other :'),
		good.replace('other: 2', 'other: 2, extra: true'),
	])
		assert.throws(() => verify(source, operation, bad));
});

test('rejects extra properties inside newly created parents', () => {
	const operation = { op: 'set', path: ['server', 'port'], value: 3001 };
	assert.throws(() =>
		verify('export default {};', operation, 'export default {server: {port: 3001, extra: true}};'),
	);
	assert.throws(() =>
		verify('export default {};', operation, 'export default {server: {port: 3001}, extra: true};'),
	);
});

test('rejects deletion, replacement and reordering of existing array items', () => {
	const source = 'export default { plugins: [one(), two()] };';
	const operation = { op: 'append', path: ['plugins'], expression: 'three()' };
	for (const items of [
		'two(), three()',
		'two(), one(), three()',
		'one(), other(), three()',
		'one(), two(), three(), three()',
	]) {
		assert.throws(() => verify(source, operation, `export default { plugins: [${items}] };`));
	}
});

test('rejects changed comments and whitespace around an inserted item', () => {
	const source = 'export default { list: [\n  1 // keep\n] };';
	const operation = { op: 'append', path: ['list'], expect: { value: [1] }, value: 2 };
	const result = applyEdits(source, [operation]);
	assert.equal(result.ok, true);
	assert.throws(() => verify(source, operation, result.code.replace('// keep', '// changed')));
	assert.throws(() => verify(source, operation, result.code.replace('  1', ' 1')));
});

test('rejects incorrect import names, kinds, extra bindings and unrelated edits', () => {
	const source = '// Header\nexport default { value: 1 };';
	const operation = { op: 'addImport', from: 'pkg', local: 'plugin' };
	for (const declaration of [
		'import other from "pkg";',
		'import plugin from "wrong";',
		'import { named as plugin } from "pkg";',
		'import type plugin from "pkg";',
		'import plugin, { extra } from "pkg";',
	])
		assert.throws(() => verify(source, operation, `${declaration}\n${source}`));
	assert.throws(() =>
		verify(source, operation, `import plugin from "pkg";\n${source.replace('Header', 'changed')}`),
	);
});

test('compares expressions without executing them and preserves template raw text', () => {
	const source = 'export default { value: null };';
	const operation = { op: 'set', path: ['value'], expression: 'plugin({ enabled: true })' };
	assert.doesNotThrow(() =>
		verify(source, operation, 'export default { value: (plugin( {enabled: true} )) };'),
	);
	assert.throws(() =>
		verify(source, operation, 'export default { value: other({ enabled: true }) };'),
	);
	assert.throws(() =>
		verify(source, { ...operation, expression: 'tag`\\n`' }, 'export default { value: tag`\n` };'),
	);
	assert.throws(() =>
		verify(source, { ...operation, expression: '/one/g' }, 'export default { value: /two/g };'),
	);
});

test('verifies supported formatting, shorthand and TypeScript cases through applyEdits', () => {
	for (const array of [
		'[]',
		'[/* keep */]',
		'[1]',
		'[1,]',
		'[1 /* keep */]',
		'[\n  1 // keep\n]',
		'[\r\n\t1, // keep\r\n]',
		'([1] as const)',
	]) {
		const result = applyEdits(
			`export default { list: ${array} } satisfies Config;`,
			[
				{
					op: 'append',
					path: ['list'],
					expect: { expression: array },
					expression: '/* leading */ second<Plugin>() // trailing',
				},
			],
			{ language: 'ts' },
		);
		assert.equal(result.ok, true, JSON.stringify({ array, result }));
	}
	for (const source of [
		'export default {};',
		'export default { /* keep */ };',
		'export default {\r\n\t// keep\r\n};',
		'export default { other: true /* keep */ };',
	]) {
		const result = applyEdits(source, [
			{ op: 'append', path: ['nested', 'list'], expect: { missing: true }, value: -0 },
		]);
		assert.equal(result.ok, true, JSON.stringify(result));
	}
	assert.equal(
		applyEdits('const value = 1; export default { value };', [
			{ op: 'set', path: ['value'], expect: { expression: 'value' }, value: 2 },
		]).ok,
		true,
	);
	for (const source of [
		'',
		'// Header',
		'#!/usr/bin/env node\r\n// Header\r\n"use client";\r\nimport old from "old"; // keep\r\nexport default {};',
	]) {
		assert.equal(
			applyEdits(source, [
				{ op: 'addImport', from: 'pkg', local: 'plugin', expect: { missing: true } },
			]).ok,
			true,
		);
	}
});
