import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { applyEdits } from 'kagaru';

const schema = JSON.parse(
	readFileSync(new URL(import.meta.resolve('kagaru/operations.schema.json')), 'utf8'),
);
const validate = new Ajv2020({ allowUnionTypes: true }).compile(schema);
const source = 'export default { plugins: [] };';

test('the exported schema and runtime accept the supported operation shapes', () => {
	for (const operations of [
		[],
		[{ op: 'set', path: ['value'], value: { list: [null, 1, true, 'text'] } }],
		[{ op: 'set', path: ['a.b', ''], expression: 'plugin()' }],
		[{ op: 'append', path: ['plugins'], value: null }],
		[{ op: 'append', path: ['plugins'], expression: 'plugin()' }],
		[{ op: 'addImport', from: 'pkg', local: 'plugin' }],
		[{ op: 'addImport', from: 'pkg', local: 'plugin', imported: 'named' }],
	]) {
		assert.equal(validate(operations), true, JSON.stringify(validate.errors));
		assert.equal(applyEdits(source, operations).ok, true);
	}
});

test('the exported schema and runtime reject invalid JSON instruction shapes', () => {
	const operations = [
		{},
		{ op: 'remove' },
		{ op: 'set', path: ['value'] },
		{ op: 'set', path: ['value'], value: 1, expression: '1' },
		{ op: 'set', path: [], value: 1 },
		{ op: 'set', path: [0], value: 1 },
		{ op: 'set', path: 'value', value: 1 },
		{ op: 'set', path: ['value'], expression: null },
		{ op: 'append', path: ['plugins'], value: 1, extra: true },
		{ op: 'addImport', from: 'pkg' },
		{ op: 'addImport', from: 'pkg', local: '' },
		{ op: 'addImport', from: 'pkg', local: 1 },
		{ op: 'addImport', from: 'pkg', local: 'plugin', imported: null },
		{ op: 'addImport', from: 'pkg', local: 'plugin', value: 1 },
	];
	for (const input of [null, {}, ...operations.map((operation) => [operation])]) {
		assert.equal(validate(input), false, JSON.stringify(input));
		assert.equal(applyEdits(source, input).error.code, 'INVALID_INPUT');
	}
});

test('schema validation leaves expression and identifier syntax to the parser', () => {
	for (const operation of [
		{ op: 'set', path: ['value'], expression: 'const value = 1' },
		{ op: 'addImport', from: 'pkg', local: 'a, {b}' },
	]) {
		assert.equal(validate([operation]), true);
		assert.equal(applyEdits(source, [operation]).ok, false);
	}
});
