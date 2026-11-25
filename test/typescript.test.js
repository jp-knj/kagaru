import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdits as applyEditsWithOptions, editConfig, expression } from 'kagaru';

const applyEdits = (source, operations, options) =>
	applyEditsWithOptions(source, operations, { wrapper: null, ...options });

const options = { language: 'ts' };

test('preserves type annotations, type imports, comments and CRLF outside edits', () => {
	const source = [
		'import type { UserConfig } from "vite";',
		'import { defineConfig, type Plugin } from "vite";',
		'const port: number = 3000;',
		'export default defineConfig<UserConfig>({',
		'\t// Keep the local API port.',
		'\tserver: ({ port: 3000 } as const),',
		'\tplugins: [',
		'\t\tfirst(), // first plugin',
		'\t] satisfies Plugin[],',
		'} as const) satisfies UserConfig;',
		'',
	].join('\r\n');
	const editor = editConfig(source, options);
	assert.equal(editor.code, source);
	editor.set(['server', 'port'], 3001).append(['plugins'], expression('second<Plugin>()', options));
	assert.equal(
		editor.code,
		source
			.replace('port: 3000', 'port: 3001')
			.replace('\t] satisfies', '\t\tsecond<Plugin>(),\r\n\t] satisfies'),
	);
});

test('edits asserted objects and call arguments through nested wrappers', () => {
	for (const target of [
		'({ value: 1 } as const) satisfies Config',
		'(({ value: 1 } satisfies Config) as Config)',
		'(defineConfig<Config>(({ value: 1 } as const)) as Config)',
	]) {
		const source = `export default ${target};`;
		assert.equal(
			editConfig(source, options).set(['value'], 2).code,
			source.replace('value: 1', 'value: 2'),
		);
	}
});

test('creates missing paths inside TypeScript wrappers', () => {
	const result = applyEdits(
		'export default ({} as const) satisfies Config;',
		[
			{ op: 'set', expect: { missing: true }, path: ['server', 'port'], value: 3001 },
			{
				op: 'append',
				expect: { missing: true },
				path: ['plugins'],
				expression: 'plugin<Options>()',
			},
		],
		options,
	);
	assert.equal(result.ok, true);
	assert.equal(
		result.code,
		'export default ({"server": {"port": 3001}, "plugins": [plugin<Options>()]} as const) satisfies Config;',
	);
});

test('validates TypeScript expressions without enabling JSX or TSX', () => {
	const editor = editConfig('export default { plugins: [] };', options);
	editor.append(['plugins'], expression('plugin<Options>() satisfies Plugin', options));
	assert.match(editor.code, /plugin<Options>\(\) satisfies Plugin/);
	assert.throws(() => expression('plugin() as Plugin'), SyntaxError);
	for (const language of ['js', 'ts']) {
		assert.throws(() => expression('<div />', { language }), SyntaxError);
		assert.throws(() => editConfig('export default { jsx: <div /> };', { language }), SyntaxError);
	}
});

test('deduplicates runtime default and named imports in TypeScript', () => {
	for (const source of [
		'import plugin from "pkg"; export default {};',
		'import { default as plugin } from "pkg"; export default {};',
		'import { type Options, plugin } from "pkg"; export default {};',
	]) {
		const imported = source.includes('Options') ? 'plugin' : 'default';
		const result = applyEdits(
			source,
			[
				{
					op: 'addImport',
					expect: { from: 'pkg', imported, kind: 'value' },
					from: 'pkg',
					local: 'plugin',
					imported,
				},
			],
			options,
		);
		assert.deepEqual(result, { ok: true, code: source, changed: false });
	}
});

test('does not reuse type-only imports as runtime imports', () => {
	for (const source of [
		'import type Plugin from "pkg"; export default {};',
		'import type { Plugin } from "pkg"; export default {};',
		'import { type Plugin } from "pkg"; export default {};',
	]) {
		const imported = source.startsWith('import type Plugin') ? 'default' : 'Plugin';
		const editor = editConfig(source, options);
		assert.throws(
			() => editor.addImport({ from: 'pkg', local: 'Plugin', imported }),
			/already declared/,
		);
		assert.equal(editor.code, source);
		editor.addImport({ from: 'pkg', local: 'runtimePlugin', imported });
		assert.ok(editor.code.startsWith(source.slice(0, source.indexOf(';') + 1)));
		assert.match(editor.code, /import .*runtimePlugin.* from "pkg";/);
	}
});

test('rejects import collisions with TypeScript and runtime declarations', () => {
	for (const declaration of [
		'type taken = {};',
		'interface taken {}',
		'export type taken = {};',
		'export interface taken {}',
		'enum taken { A }',
		'namespace taken {}',
		'declare const taken: unknown;',
		'const { nested: [taken] } = value;',
		'function taken() {}',
		'class taken {}',
		'import taken from "another";',
		'import * as taken from "another";',
	]) {
		const result = applyEdits(
			`${declaration} export default {};`,
			[{ op: 'addImport', expect: { missing: true }, from: 'pkg', local: 'taken' }],
			options,
		);
		assert.equal(result.ok, false, declaration);
		assert.equal(result.error.code, 'PRECONDITION_FAILED', declaration);
		assert.equal(result.error.operationIndex, 0);
		assert.equal('code' in result, false);
	}
});

test('preserves CRLF, directives and import comments when adding a TypeScript import', () => {
	const source =
		'#!/usr/bin/env node\r\n// Header\r\n"use client";\r\nimport type { C } from "c"; // types\r\nexport default {} satisfies C;\r\n';
	const editor = editConfig(source, options).addImport({ from: 'pkg', local: 'plugin' });
	assert.equal(
		editor.code,
		source.replace('// types\r\n', '// types\r\nimport plugin from "pkg";\r\n'),
	);
});
