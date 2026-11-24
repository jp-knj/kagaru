import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mutations = JSON.parse(
	readFileSync(new URL('../test/mutations.json', import.meta.url), 'utf8'),
);
const directory = mkdtempSync(join(tmpdir(), 'kagaru-mutations-'));
const report = { baseline: null, mutations: [] };

function run(args) {
	const result = spawnSync(process.execPath, args, {
		cwd: directory,
		encoding: 'utf8',
		timeout: 120000,
	});
	return {
		status: result.status,
		error: result.error?.message,
		failedTests: [...result.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((match) => match[1]),
		output: result.stdout + result.stderr,
	};
}

try {
	assert.ok(mutations.length, 'The contract mutation list must not be empty.');
	assert.equal(
		new Set(mutations.map(({ id }) => id)).size,
		mutations.length,
		'Mutation IDs must be unique.',
	);
	for (const file of ['package.json', 'operations.schema.json', 'dist', 'test']) {
		cpSync(join(root, file), join(directory, file), { recursive: true });
	}
	symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'junction');
	const tests = readdirSync(join(directory, 'test'))
		.filter((file) => file.endsWith('.test.js'))
		.map((file) => `test/${file}`);
	const baseline = run(['--test', '--test-reporter=tap', ...tests]);
	report.baseline = { status: baseline.status, error: baseline.error };
	assert.equal(baseline.status, 0, baseline.output);
	console.log('Unmodified tests passed.');
	for (const mutation of mutations) {
		const filename = join(directory, mutation.file);
		const original = readFileSync(filename, 'utf8');
		assert.equal(
			original.split(mutation.before).length - 1,
			1,
			`Mutation target must match once: ${mutation.id}`,
		);
		writeFileSync(filename, original.replace(mutation.before, mutation.after));
		let result;
		try {
			const syntax = run(['--check', mutation.file]);
			if (syntax.status !== 0) {
				result = { outcome: 'invalid', output: syntax.output };
			} else {
				const tested = run(['--test', '--test-reporter=tap', ...tests]);
				const outcome =
					tested.error || tested.status === null
						? 'error'
						: tested.status === 0
							? 'survived'
							: tested.status === 1 && tested.failedTests.length
								? 'killed'
								: 'error';
				result = { outcome, failedTests: tested.failedTests };
				if (outcome === 'error') result.output = tested.output;
			}
		} finally {
			writeFileSync(filename, original);
		}
		report.mutations.push({ id: mutation.id, ...result });
		console.log(`${mutation.id}: ${result.outcome}`);
	}
	const killed = report.mutations.filter(({ outcome }) => outcome === 'killed').length;
	console.log(`Detected ${killed}/${mutations.length} contract mutations.`);
	if (killed !== mutations.length) process.exitCode = 1;
} catch (error) {
	report.error = error.message;
	console.error(error);
	process.exitCode = 1;
} finally {
	mkdirSync(join(root, 'reports'), { recursive: true });
	writeFileSync(
		join(root, 'reports/contract-mutation.json'),
		JSON.stringify(report, null, 2) + '\n',
	);
	rmSync(directory, { recursive: true, force: true });
}
