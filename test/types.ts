import { applyEdits, editConfig, expression } from 'kagaru';
import type { ApplyEditsResult, EditOperation, EditOptions, Expression, JsonValue } from 'kagaru';

const options: EditOptions = { language: 'ts' };
const operations = [
	{ op: 'set', expect: { value: 3000 }, path: ['server', 'port'], value: 3001 },
	{ op: 'append', expect: { expression: '[first()]' }, path: ['plugins'], expression: 'react()' },
	{
		op: 'set',
		expect: { missing: true },
		path: ['enabled'],
		value: { nested: [null, true, 1, 'text'] },
	},
	{ op: 'addImport', expect: { missing: true }, from: '@vitejs/plugin-react', local: 'react' },
	{
		op: 'addImport',
		expect: { from: 'vite', imported: 'defineConfig', kind: 'value' },
		from: 'vite',
		local: 'config',
		imported: 'defineConfig',
	},
] satisfies EditOperation[];
const result: ApplyEditsResult = applyEdits('export default {};', operations, options);
if (result.ok) {
	const code: string = result.code;
	const changed: boolean = result.changed;
} else {
	const index: number | null = result.error.operationIndex;
	const code:
		| 'INVALID_INPUT'
		| 'INVALID_SOURCE'
		| 'INVALID_EXPRESSION'
		| 'EDIT_FAILED'
		| 'PRECONDITION_FAILED'
		| 'VERIFICATION_FAILED' = result.error.code;
	const message: string = result.error.message;
}
const value: Expression = expression('plugin() as Plugin', options);
editConfig('export default {} as const;', options).set(['plugin'], value);
editConfig('export default {};').append(['list'], expression('plugin()'));
applyEdits('export default {};', [
	{ op: 'set', expect: { missing: true }, path: ['port'], value: 1 },
] as const);

type Assert<T extends true> = T;
type Reject<T> = T extends EditOperation ? false : true;
type InvalidOperations = [
	Assert<Reject<{ op: 'set'; path: ['value']; value: 1 }>>,
	Assert<Reject<{ op: 'addImport'; from: 'pkg'; local: 'plugin' }>>,
	Assert<Reject<{ op: 'set'; path: ['value']; value: 1; expect: { missing: false } }>>,
	Assert<Reject<{ op: 'set'; path: ['value']; value: 1; expect: { value: 1; expression: '1' } }>>,
	Assert<Reject<{ op: 'set'; path: ['value']; value: 1; expect: { missing: true; value: 1 } }>>,
	Assert<Reject<{ op: 'addImport'; from: 'pkg'; local: 'plugin'; expect: { value: 1 } }>>,
	Assert<
		Reject<{
			op: 'addImport';
			from: 'pkg';
			local: 'plugin';
			expect: { from: 'pkg'; imported: 'default'; kind: 'runtime' };
		}>
	>,
	Assert<Reject<{ op: 'remove'; path: ['value'] }>>,
	Assert<Reject<{ op: 'set'; expect: { missing: true }; path: []; value: 1 }>>,
	Assert<Reject<{ op: 'set'; expect: { missing: true }; path: [0]; value: 1 }>>,
	Assert<Reject<{ op: 'set'; expect: { missing: true }; path: ['value'] }>>,
	Assert<
		Reject<{ op: 'set'; expect: { missing: true }; path: ['value']; value: 1; expression: '1' }>
	>,
	Assert<Reject<{ op: 'append'; expect: { missing: true }; path: ['list']; expression: 1 }>>,
	Assert<Reject<{ op: 'set'; expect: { missing: true }; path: ['value']; value: undefined }>>,
	Assert<Reject<{ op: 'set'; expect: { missing: true }; path: ['value']; value: bigint }>>,
	Assert<Reject<{ op: 'addImport'; expect: { missing: true }; from: 'pkg' }>>,
	Assert<Reject<{ op: 'addImport'; expect: { missing: true }; from: 'pkg'; local: 1 }>>,
	Assert<
		Reject<{
			op: 'addImport';
			expect: { missing: true };
			from: 'pkg';
			local: 'plugin';
			imported: null;
		}>
	>,
	Assert<{ language: 'tsx' } extends EditOptions ? false : true>,
	Assert<Expression extends JsonValue ? false : true>,
];
