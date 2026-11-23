import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyEdits } from 'kagaru';

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
	const cases = [
		['js', '/** @type {number} */\nconst port = "wrong";', ['2322']],
		['js', '/** @type {number} */\n// Keep this setting\nconst port = "wrong";', ['2322']],
		['js', '// @ts-nocheck\n/** @type {number} */\nconst port = "wrong";', []],
		['js', 'import old from "./dependency.js"; /** @type {number} */\nconst port = "wrong";', []],
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
	for (const [index, [language, statement, expected]] of cases.entries()) {
		const source = `${statement}\nexport default { port };`;
		const result = applyEdits(source, [operation], { language });
		assert.equal(result.ok, true, source);
		for (const [state, code] of [
			['before', source],
			['after', result.code],
		]) {
			const filename = join(directory, `${index}-${state}.${language}`);
			writeFileSync(filename, code);
			const checked = spawnSync(
				process.execPath,
				[
					tsc,
					'--ignoreConfig',
					'--noEmit',
					'--allowJs',
					'--checkJs',
					'--module',
					'nodenext',
					'--target',
					'es2022',
					filename,
				],
				{ encoding: 'utf8' },
			);
			assert.ifError(checked.error);
			assert.notEqual(checked.status, null, checked.stderr);
			assert.equal(checked.status === 0, expected.length === 0, checked.stdout + checked.stderr);
			assert.deepEqual(
				[...checked.stdout.matchAll(/error TS(\d+):/g)].map((match) => match[1]),
				expected,
				code,
			);
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
