import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyEdits as applyEditsWithOptions, editConfig } from 'kagaru';

const applyEdits = (source, operations, options) =>
	applyEditsWithOptions(source, operations, { wrapper: null, ...options });

const operation = {
	op: 'addImport',
	from: './dependency.js',
	local: 'plugin',
	expect: { missing: true },
};
const tsc = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));

test('keeps JSDoc with its statement through intervening comments and file headers', () => {
	for (const language of ['js', 'ts']) {
		for (const newline of ['\n', '\r\n']) {
			for (const header of ['', '#!/usr/bin/env node\n', '// @ts-check\n', '/** License */\n']) {
				for (const separator of ['', '// Keep this setting\n', '/* Keep this setting */\n']) {
					const leading = header.replaceAll('\n', newline);
					const documented =
						`/** @type {number} */\n${separator}const port = "wrong";\nexport default { port };`.replaceAll(
							'\n',
							newline,
						);
					const result = applyEdits(leading + documented, [operation], { language });
					assert.equal(result.ok, true);
					assert.equal(
						result.code,
						`${leading}import plugin from "./dependency.js";${newline}${documented}`,
					);
				}
			}
		}
	}
});

test('preserves TypeScript diagnostics when adding an import near compiler comments', (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'kagaru-comment-diagnostics-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, 'dependency.js'), 'export default {};');
	writeFileSync(join(directory, 'types.d.ts'), 'type Port = number;');
	const cases = [
		['js', '/** @type {number} */\nconst port = "wrong";', ['2322']],
		['js', '/** @type {number} */\n// Keep this setting\nconst port = "wrong";', ['2322']],
		['js', '// @ts-nocheck\n/** @type {number} */\nconst port = "wrong";', []],
		['js', 'import old from "./dependency.js"; /** @type {number} */\nconst port = "wrong";', []],
		['js', '// @ts-check\n/** @type {number} */\nconst port = "wrong";', ['2322'], false],
		['js', '/** @type {number} */\n/** Port */\nconst port = "wrong";', []],
		['js', '/** Port */\n/** @type {number} */\nconst port = "wrong";', ['2322']],
		[
			'js',
			'/** @type {number} */\nconst port = "wrong";\n/** Other setting */\nconst host = "localhost";',
			['2322'],
		],
		['js', '/** @param {number} value */\nfunction port(value) {}\nport("wrong");', ['2345']],
		['ts', '/// <reference path="./types.d.ts" />\nconst port: Port = 3000;', []],
		['ts', '// @ts-expect-error\nimport old from "./missing.js";\nconst port: number = 3000;', []],
		['ts', '// Example: @ts-expect-error\nconst port: number = "wrong";', ['2322']],
		['ts', '/* @ts-expect-error\n */\nconst port: number = "wrong";', ['2322']],
		['ts', '/* Explanation @ts-ignore */\nconst port: number = "wrong";', ['2322']],
		['ts', '// @ts-expect-error: incompatible fixture\nconst port: number = "wrong";', []],
		['ts', '"use client"; // @ts-expect-error\nconst port: number = "wrong";', []],
		[
			'ts',
			'import old from "./dependency.js"; // @ts-expect-error\r\nconst port: number = "wrong";',
			[],
		],
	];
	for (const directive of [
		'// @ts-ignore',
		'// @ts-expect-error',
		'/// @ts-expect-error',
		'/* @ts-expect-error */',
		'/** @ts-expect-error */',
		'/* Explanation\n * @ts-expect-error */',
	]) {
		for (const prefix of ['', 'import old from "./dependency.js"; ']) {
			cases.push(['ts', `${prefix}${directive}\nconst port: number = "wrong";`, []]);
		}
	}
	const fixtures = [];
	for (const [index, [language, statement, expected, checkJs = true]] of cases.entries()) {
		const source = `${statement}\nexport default { port };`;
		const result = applyEdits(source, [operation], { language });
		assert.equal(result.ok, true, source);
		for (const [state, code] of [
			['before', source],
			['after', result.code],
		]) {
			const filename = join(directory, `${index}-${state}.${language}`);
			writeFileSync(filename, code);
			fixtures.push({ filename, state, checkJs, expected, code });
		}
	}
	for (const state of ['before', 'after']) {
		for (const checkJs of [true, false]) {
			const group = fixtures.filter(
				(fixture) => fixture.state === state && fixture.checkJs === checkJs,
			);
			const checked = spawnSync(
				process.execPath,
				[
					tsc,
					'--ignoreConfig',
					'--noEmit',
					'--allowJs',
					'--checkJs',
					String(checkJs),
					'--module',
					'nodenext',
					'--target',
					'es2022',
					...group.map((fixture) => fixture.filename),
				],
				{ encoding: 'utf8' },
			);
			assert.ifError(checked.error);
			assert.notEqual(checked.status, null, checked.stderr);
			assert.equal(
				checked.status === 0,
				group.every((fixture) => !fixture.expected.length),
				checked.stdout + checked.stderr,
			);
			const diagnostics = new Map(group.map((fixture) => [basename(fixture.filename), []]));
			const messages = [...checked.stdout.matchAll(/^(.*)\(\d+,\d+\): error TS(\d+):/gm)];
			assert.equal(
				messages.length,
				[...checked.stdout.matchAll(/error TS\d+:/g)].length,
				checked.stdout,
			);
			for (const [, file, code] of messages) {
				assert.ok(diagnostics.has(basename(file)), checked.stdout);
				diagnostics.get(basename(file)).push(code);
			}
			for (const fixture of group) {
				assert.deepEqual(
					diagnostics.get(basename(fixture.filename)),
					fixture.expected,
					fixture.code,
				);
			}
		}
	}
});

test('rejects import positions that separate overlapping file and statement comments', () => {
	for (const header of [
		'// @ts-check',
		'// @ts-nocheck',
		'/// <reference path="./types.d.ts" />',
	]) {
		const result = applyEdits(
			`/** @type {number} */\n${header}\nconst port = "wrong";\nexport default { port };`,
			[operation],
		);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, 'EDIT_FAILED');
		assert.equal('code' in result, false);
	}
});

test('preserves comments in files with no statements or final newline', () => {
	for (const [source, expected] of [
		['// @ts-nocheck', '// @ts-nocheck\nimport plugin from "./dependency.js";\n'],
		['/** @type {number} */', 'import plugin from "./dependency.js";\n/** @type {number} */'],
		['// @ts-expect-error', 'import plugin from "./dependency.js";\n// @ts-expect-error'],
		[
			'#!/usr/bin/env node\n// @ts-ignore',
			'#!/usr/bin/env node\nimport plugin from "./dependency.js";\n// @ts-ignore',
		],
	]) {
		for (const language of ['js', 'ts']) {
			assert.deepEqual(applyEdits(source, [operation], { language }), {
				ok: true,
				code: expected,
				changed: true,
			});
		}
	}
});

test('keeps compiler comments attached through a batch of imports and config edits', () => {
	const header = '#!/usr/bin/env node\n// @ts-check\n';
	const documented = '/** @type {{ port: number }} */\nexport default { port: 3000 };';
	const imports = [operation, { ...operation, local: 'second', imported: 'named' }];
	const result = applyEdits(header + documented, [
		...imports,
		{ op: 'set', path: ['port'], expect: { value: 3000 }, value: 3001 },
	]);
	assert.deepEqual(result, {
		ok: true,
		code: `${header}import plugin from "./dependency.js";\nimport { "named" as second } from "./dependency.js";\n${documented.replace('3000', '3001')}`,
		changed: true,
	});
	const repeated = applyEdits(result.code, imports);
	assert.equal(repeated.ok, false);
	assert.equal(repeated.error.code, 'PRECONDITION_FAILED');
	assert.equal(repeated.error.operationIndex, 0);
	assert.equal('code' in repeated, false);
});

test('returns no partial code when a later import cannot preserve compiler comments', () => {
	const source = '/** @type {{ port: number }} */\n// @ts-nocheck\nexport default { port: 3000 };';
	const result = applyEdits(source, [
		{ op: 'set', path: ['port'], expect: { value: 3000 }, value: 3001 },
		operation,
	]);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'EDIT_FAILED');
	assert.equal(result.error.operationIndex, 1);
	assert.deepEqual(Object.keys(result), ['ok', 'error']);
});

test('keeps fluent editor state intact when an import cannot preserve compiler comments', () => {
	const source = '/** @type {{ port: number }} */\n// @ts-nocheck\nexport default { port: 3000 };';
	const editor = editConfig(source).set(['port'], 3001);
	assert.throws(() => editor.addImport({ from: operation.from, local: operation.local }));
	assert.equal(editor.code, source.replace('3000', '3001'));
});

test('accepts an existing import without moving its compiler comments', () => {
	const source = `/** Plugin */\n// @ts-nocheck\nimport plugin from "./dependency.js";\nexport default {};`;
	assert.deepEqual(
		applyEdits(source, [
			{
				...operation,
				expect: { from: operation.from, imported: 'default', kind: 'value' },
			},
		]),
		{ ok: true, code: source, changed: false },
	);
});
