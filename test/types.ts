import { applyEdits, editConfig, expression } from 'kagaru';
import type { ApplyEditsResult, EditOperation, EditOptions, Expression, JsonValue } from 'kagaru';

const options: EditOptions = { language: 'ts' };
const operations = [
	{ op: 'set', path: ['server', 'port'], value: 3001 },
	{ op: 'append', path: ['plugins'], expression: 'react()' },
	{ op: 'set', path: ['enabled'], value: { nested: [null, true, 1, 'text'] } },
	{ op: 'addImport', from: '@vitejs/plugin-react', local: 'react' },
	{ op: 'addImport', from: 'vite', local: 'config', imported: 'defineConfig' },
] satisfies EditOperation[];
const result: ApplyEditsResult = applyEdits('export default {};', operations, options);
if (result.ok) {
	const code: string = result.code;
	const changed: boolean = result.changed;
} else {
	const index: number | null = result.error.operationIndex;
	const code: 'INVALID_INPUT' | 'INVALID_SOURCE' | 'INVALID_EXPRESSION' | 'EDIT_FAILED' =
		result.error.code;
	const message: string = result.error.message;
}
const value: Expression = expression('plugin() as Plugin', options);
editConfig('export default {} as const;', options).set(['plugin'], value);
editConfig('export default {};').append(['list'], expression('plugin()'));
applyEdits('export default {};', [{ op: 'set', path: ['port'], value: 1 }] as const);

type Assert<T extends true> = T;
type Reject<T> = T extends EditOperation ? false : true;
type InvalidOperations = [
	Assert<Reject<{ op: 'remove'; path: ['value'] }>>,
	Assert<Reject<{ op: 'set'; path: []; value: 1 }>>,
	Assert<Reject<{ op: 'set'; path: [0]; value: 1 }>>,
	Assert<Reject<{ op: 'set'; path: ['value'] }>>,
	Assert<Reject<{ op: 'set'; path: ['value']; value: 1; expression: '1' }>>,
	Assert<Reject<{ op: 'append'; path: ['list']; expression: 1 }>>,
	Assert<Reject<{ op: 'set'; path: ['value']; value: undefined }>>,
	Assert<Reject<{ op: 'set'; path: ['value']; value: bigint }>>,
	Assert<Reject<{ op: 'addImport'; from: 'pkg' }>>,
	Assert<Reject<{ op: 'addImport'; from: 'pkg'; local: 1 }>>,
	Assert<Reject<{ op: 'addImport'; from: 'pkg'; local: 'plugin'; imported: null }>>,
	Assert<{ language: 'tsx' } extends EditOptions ? false : true>,
	Assert<Expression extends JsonValue ? false : true>,
];
