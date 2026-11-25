import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { applyEdits as applyEditsWithOptions } from 'kagaru';

const applyEdits = (source, operations, options) =>
	applyEditsWithOptions(source, operations, { wrapper: null, ...options });

const schema = JSON.parse(
	readFileSync(new URL(import.meta.resolve('kagaru/operations.schema.json')), 'utf8'),
);
const validate = new Ajv2020({ allowUnionTypes: true }).compile(schema);
const source = 'export default { plugins: [] };';

test('the exported schema and runtime accept the supported operation shapes', () => {
	for (const operations of [
		[],
		[
			{
				op: 'set',
				expect: { missing: true },
				path: ['value'],
				value: { list: [null, 1, true, 'text'] },
			},
		],
		[{ op: 'set', expect: { missing: true }, path: ['a.b', ''], expression: 'plugin()' }],
		[{ op: 'append', expect: { value: [] }, path: ['plugins'], value: null }],
		[{ op: 'append', expect: { value: [] }, path: ['plugins'], expression: 'plugin()' }],
		[{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'plugin' }],
		[
			{
				op: 'addImport',
				expect: { missing: true },
				from: 'pkg',
				local: 'plugin',
				imported: 'named',
			},
		],
	]) {
		assert.equal(validate(operations), true, JSON.stringify(validate.errors));
		assert.equal(applyEdits(source, operations).ok, true);
	}
});

test('the exported schema and runtime reject invalid JSON instruction shapes', () => {
	const operations = [
		{},
		{ op: 'remove' },
		{ op: 'set', expect: { missing: true }, path: ['value'] },
		{ op: 'set', expect: { missing: true }, path: ['value'], value: 1, expression: '1' },
		{ op: 'set', expect: { missing: true }, path: [], value: 1 },
		{ op: 'set', expect: { missing: true }, path: [0], value: 1 },
		{ op: 'set', expect: { missing: true }, path: 'value', value: 1 },
		{ op: 'set', expect: { missing: true }, path: ['value'], expression: null },
		{ op: 'append', expect: { value: [] }, path: ['plugins'], value: 1, extra: true },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg' },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: '' },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 1 },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'plugin', imported: null },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'plugin', value: 1 },
	];
	for (const input of [null, {}, ...operations.map((operation) => [operation])]) {
		assert.equal(validate(input), false, JSON.stringify(input));
		assert.equal(applyEdits(source, input).error.code, 'INVALID_INPUT');
	}
});

test('schema validation leaves expression and identifier syntax to the parser', () => {
	for (const operation of [
		{ op: 'set', expect: { missing: true }, path: ['value'], expression: 'const value = 1' },
		{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'a, {b}' },
	]) {
		assert.equal(validate([operation]), true);
		assert.equal(applyEdits(source, [operation]).ok, false);
	}
});

test('schema and runtime require exactly one well-formed precondition', () => {
	for (const expect of [
		undefined,
		null,
		{},
		{ missing: false },
		{ missing: true, value: null },
		{ value: 1, expression: '1' },
		{ expression: 1 },
		{ value: 1, extra: true },
	]) {
		const operation = { op: 'set', path: ['value'], value: 1 };
		if (expect !== undefined) operation.expect = expect;
		assert.equal(validate([operation]), false);
		assert.equal(applyEdits(source, [operation]).error.code, 'INVALID_INPUT');
	}
	for (const expect of [
		undefined,
		{ value: null },
		{ from: 'pkg', imported: 'default' },
		{ from: 'pkg', imported: 'default', kind: 'runtime' },
		{ from: 'pkg', imported: 'default', kind: 'value', missing: true },
	]) {
		const operation = { op: 'addImport', from: 'pkg', local: 'plugin' };
		if (expect !== undefined) operation.expect = expect;
		assert.equal(validate([operation]), false);
		assert.equal(applyEdits(source, [operation]).error.code, 'INVALID_INPUT');
	}
	for (const kind of ['type', 'value']) {
		const operation = {
			op: 'addImport',
			from: 'pkg',
			local: 'plugin',
			expect: { from: 'pkg', imported: 'default', kind },
		};
		assert.equal(validate([operation]), true);
		assert.equal(applyEdits(source, [operation]).error.code, 'PRECONDITION_FAILED');
	}
});
