import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expression, editConfig } from 'kagaru';

async function configValue(editor) {
	return (await import(`data:text/javascript,${encodeURIComponent(editor.code)}`)).default;
}

test('an untouched module is returned byte for byte', () => {
	const source = '#!/usr/bin/env node\r\n// Header\r\nexport default { a: 1 };\r\n';
	assert.equal(editConfig(source).code, source);
});

test('replacing a value preserves every surrounding character', () => {
	const source = "export default {\n\t// Site URL\n\tsite : /* keep */ 'old' /* keep too */,\n};\n";
	const editor = editConfig(source).set(['site'], 'new');
	assert.equal(editor.code, source.replace("'old'", '"new"'));
});

test('edits object literals wrapped in a config function', () => {
	const editor = editConfig('export default defineConfig(({ server: { port: 1 } }));');
	editor.set(['server', 'port'], 4321);
	assert.equal(editor.code, 'export default defineConfig(({ server: { port: 4321 } }));');
});

test('creates missing parent objects without touching siblings', async () => {
	const editor = editConfig('export default { existing: true };');
	editor.set(['server', 'port'], 4321);
	assert.deepEqual(await configValue(editor), { existing: true, server: { port: 4321 } });
});

test('expands a shorthand property without changing its declaration', async () => {
	const editor = editConfig('const site = "old"; export default { site };');
	editor.set(['site'], 'new');
	assert.equal(editor.code, 'const site = "old"; export default { site: "new" };');
	assert.deepEqual(await configValue(editor), { site: 'new' });
});

test('supports quoted keys, including an empty key and a dotted key', async () => {
	const editor = editConfig('export default { "a.b": { "": 1 } };');
	editor.set(['a.b', ''], 2);
	assert.deepEqual(await configValue(editor), { 'a.b': { '': 2 } });
});

test('appends repeatedly to empty and non-empty inline arrays', async () => {
	const editor = editConfig('export default { list: [] };');
	editor.append(['list'], 1).append(['list'], 2).append(['list'], 3);
	assert.deepEqual(await configValue(editor), { list: [1, 2, 3] });
});

test('creates a missing array and parent objects', async () => {
	const editor = editConfig('export default {};').append(['vite', 'plugins'], 'first');
	assert.deepEqual(await configValue(editor), { vite: { plugins: ['first'] } });
});

test('preserves trailing commas and line comments when appending', async () => {
	const editor = editConfig('export default { list: [\n  1, // first\n] };');
	editor.append(['list'], 2);
	assert.ok(editor.code.includes('  1, // first\n  2,\n'));
	assert.deepEqual(await configValue(editor), { list: [1, 2] });
});

test('adds a comma before an existing trailing comment', async () => {
	const editor = editConfig('export default { list: [\n  1 // first\n] };');
	editor.append(['list'], 2);
	assert.ok(editor.code.includes('  1, // first\n  2\n'));
	assert.deepEqual(await configValue(editor), { list: [1, 2] });
});

test('preserves block comments, parentheses and multiline strings', async () => {
	const editor = editConfig('export default { list: [(1) /* first */] };');
	editor.append(['list'], expression('`hello\nworld`'));
	assert.ok(editor.code.includes('(1), /* first */'));
	assert.deepEqual(await configValue(editor), { list: [1, 'hello\nworld'] });
});

test('retains CRLF and tab indentation', async () => {
	const editor = editConfig('export default {\r\n\tlist: [\r\n\t\t1,\r\n\t],\r\n};\r\n');
	editor.append(['list'], 2);
	assert.ok(editor.code.includes('\r\n\t\t2,\r\n'));
	assert.equal(editor.code.replaceAll('\r\n', '').includes('\n'), false);
	assert.deepEqual(await configValue(editor), { list: [1, 2] });
});

test('preserves comments inside empty multiline containers', async () => {
	const editor = editConfig('export default {\n  // Configuration\n};');
	editor.append(['list'], true);
	assert.ok(editor.code.includes('// Configuration\n'));
	assert.deepEqual(await configValue(editor), { list: [true] });
});

test('comma expressions remain one array item', async () => {
	const editor = editConfig('export default { list: [] };');
	editor.append(['list'], expression('1, 2'));
	assert.deepEqual(await configValue(editor), { list: [2] });
});

test('raw expressions can end with a line comment', async () => {
	const editor = editConfig('export default { list: [] };');
	editor.append(['list'], expression('1 // preserved'));
	assert.deepEqual(await configValue(editor), { list: [1] });
});

test('rejects statements passed as an expression', () => {
	assert.throws(() => expression('one); doSomething(); (two'), SyntaxError);
	assert.throws(() => expression('const value = 1'), SyntaxError);
});

test('never executes input or inserted expressions while editing', () => {
	const editor = editConfig('throw new Error("Do not execute"); export default {};');
	editor.set(['value'], expression('runApplication()'));
	assert.ok(editor.code.includes('runApplication()'));
});

test('adds default and named imports and avoids exact duplicates', () => {
	const editor = editConfig('export default {};');
	editor.addImport({ from: 'react', local: 'React' });
	editor.addImport({ from: 'react', imported: 'useState', local: 'state' });
	const once = editor.code;
	editor.addImport({ from: 'react', imported: 'useState', local: 'state' });
	assert.equal(editor.code, once);
	assert.match(editor.code, /import React from "react";/);
	assert.match(editor.code, /import \{ "useState" as state \} from "react";/);
});

test('keeps a shebang, header, directives and import comments in place', () => {
	const editor = editConfig(
		'#!/usr/bin/env node\n// Header\n"use client";\nimport old from "old"; // old import\nexport default {};',
	);
	editor.addImport({ from: 'new', local: 'next' });
	assert.ok(editor.code.startsWith('#!/usr/bin/env node\n// Header\n"use client";'));
	assert.ok(editor.code.includes('import old from "old"; // old import\nimport next from "new";'));
});

test('supports import-only and empty modules', () => {
	for (const source of ['', '// Header', '#!/usr/bin/env node\n']) {
		const editor = editConfig(source).addImport({ from: 'pkg', local: 'pkg' });
		assert.ok(editor.code.startsWith(source));
		assert.match(editor.code, /import pkg from "pkg";/);
	}
});

test('failed imports do not mutate the module', () => {
	const source = 'const taken = 1; export default {};';
	const editor = editConfig(source);
	assert.throws(() => editor.addImport({ from: 'pkg', local: 'taken' }), SyntaxError);
	assert.throws(() => editor.addImport({ from: 'pkg', local: 'a, {b}' }), SyntaxError);
	assert.throws(() => editor.addImport({ from: 'pkg', local: '("pkg"); //' }), SyntaxError);
	assert.equal(editor.code, source);
});

test('rejects unsupported targets without changing the source', () => {
	for (const source of [
		'const config = {}; export default config;',
		'export default () => ({});',
		'export default { ...base };',
		'export default { [key]: 1 };',
		'export default { get value() { return 1; } };',
		'export default { method() {} };',
		'export default { value: 1, value: 2 };',
	]) {
		const editor = editConfig(source);
		assert.throws(() => editor.set(['value'], 3));
		assert.equal(editor.code, source);
	}
});

test('rejects non-literal containers and sparse arrays', () => {
	const editor = editConfig('export default { list: [1,,], value: 1 };');
	assert.throws(() => editor.append(['list'], 2), /sparse arrays/);
	assert.throws(() => editor.append(['value'], 2), /array literal/);
	assert.throws(() => editor.set(['value', 'nested'], true), /object literals/);
	assert.throws(() => editor.set([], true), /non-empty array/);
});

test('does not silently accept TypeScript or JSX syntax', () => {
	assert.throws(() => editConfig('export default {} satisfies Config;'), SyntaxError);
	assert.throws(() => editConfig('export default { element: <div /> };'), SyntaxError);
});
