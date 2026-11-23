import { Parser } from 'acorn';
import type { Comment, Node, ObjectExpression, ArrayExpression, Property, Options } from 'acorn';
import { tsPlugin } from '@sveltejs/acorn-typescript';
import { isNode } from './ast.js';
import type { Module, Snapshot } from './ast.js';
import { checkPrecondition, verifyEdit } from './verification.js';
import { importCommentRange } from './comments.js';

declare const expressionBrand: unique symbol;

export interface Expression {
	readonly [expressionBrand]: true;
}

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface EditOptions {
	language?: 'js' | 'ts';
}

export type ValueExpectation =
	| { missing: true; value?: never; expression?: never }
	| { value: JsonValue; missing?: never; expression?: never }
	| { expression: string; missing?: never; value?: never };

export type ImportExpectation =
	| { missing: true; from?: never; imported?: never; kind?: never }
	| { from: string; imported: string; kind: 'value' | 'type'; missing?: never };

export type EditOperation =
	| ({ op: 'set' | 'append'; path: readonly [string, ...string[]]; expect: ValueExpectation } & (
			| { value: JsonValue; expression?: never }
			| { expression: string; value?: never }
	  ))
	| { op: 'addImport'; from: string; local: string; imported?: string; expect: ImportExpectation };

export type ApplyEditsResult =
	| { ok: true; code: string; changed: boolean }
	| {
			ok: false;
			error: {
				code:
					| 'INVALID_INPUT'
					| 'INVALID_SOURCE'
					| 'INVALID_EXPRESSION'
					| 'EDIT_FAILED'
					| 'PRECONDITION_FAILED'
					| 'VERIFICATION_FAILED';
				operationIndex: number | null;
				message: string;
			};
	  };

export interface ConfigEditor {
	readonly code: string;
	set(path: readonly string[], value: JsonValue | Expression): this;
	append(path: readonly string[], value: JsonValue | Expression): this;
	addImport(options: { from: string; local: string; imported?: string }): this;
}

const parserOptions: Options = {
	ecmaVersion: 'latest',
	sourceType: 'module',
	preserveParens: true,
};
const TypeScriptParser = Parser.extend(tsPlugin({ jsx: false }));

function parse(
	source: string,
	options: EditOptions,
	callbacks: Pick<Options, 'onComment' | 'onTrailingComma'> = {},
): Module {
	if (typeof source !== 'string') throw new TypeError('Source must be a string.');
	validateOptions(options);
	return options.language === 'ts'
		? TypeScriptParser.parse(source, { ...parserOptions, locations: true, ...callbacks })
		: Parser.parse(source, { ...parserOptions, ...callbacks });
}

function validateOptions(options: unknown): asserts options is EditOptions {
	if (
		!isRecord(options) ||
		Reflect.ownKeys(options).some((key) => key !== 'language') ||
		(options.language !== undefined && options.language !== 'js' && options.language !== 'ts')
	) {
		throw new TypeError('Expected options with language "js" or "ts".');
	}
}

class ExpressionValue implements Expression {
	declare readonly [expressionBrand]: true;
	readonly code: string;

	constructor(code: string) {
		this.code = code;
	}
}

export function expression(code: string, options: EditOptions = {}): Expression {
	return parseExpression(code, options).value;
}

function parseExpression(
	code: string,
	options: EditOptions,
): { value: ExpressionValue; node: Node } {
	if (typeof code !== 'string') throw new TypeError('Expression must be a string.');
	const comments: Comment[] = [];
	const wrapped = `(\n${code}\n)`;
	const ast = parse(wrapped, options, { onComment: comments });
	const statement = ast.body[0];
	const root = isNode(statement, 'ExpressionStatement') ? statement.expression : undefined;
	if (
		ast.body.length !== 1 ||
		!isNode(root, 'ParenthesizedExpression') ||
		root.end !== wrapped.length
	) {
		throw new SyntaxError('Expected one expression.');
	}
	const node = root.expression;
	const trailingLineComment = comments.some(
		(comment) => comment.type === 'Line' && code.slice(comment.end - 2).trim() === '',
	);
	const value = new ExpressionValue(
		node.type === 'SequenceExpression' ? `(${code}\n)` : code + (trailingLineComment ? '\n' : ''),
	);
	return { value, node };
}

function serialize(value: JsonValue | Expression): string {
	if (value instanceof ExpressionValue) return value.code;
	if (isJsonValue(value)) return serializeJson(value);
	const code = JSON.stringify(value);
	if (code === undefined) throw new TypeError('Use expression() for non-JSON values.');
	return code;
}

function propertyName(key: string): string {
	return key === '__proto__' ? '["__proto__"]' : JSON.stringify(key);
}

function serializeJson(value: JsonValue): string {
	if (Object.is(value, -0)) return '-0';
	if (Array.isArray(value)) return `[${value.map(serializeJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.map(([key, item]) => `${propertyName(key)}:${serializeJson(item)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function unwrap(node: Node | null | undefined): Node | undefined {
	while (
		isNode(node, 'ParenthesizedExpression') ||
		isNode(node, 'TSAsExpression') ||
		isNode(node, 'TSSatisfiesExpression')
	)
		node = node.expression;
	return node ?? undefined;
}

function property(object: ObjectExpression, key: string): Property | undefined {
	const properties = object.properties.map((prop) => {
		if (
			prop.type !== 'Property' ||
			prop.method ||
			prop.kind !== 'init' ||
			(prop.computed && (prop.key.type !== 'Literal' || typeof prop.key.value !== 'string')) ||
			(!prop.computed &&
				!prop.shorthand &&
				(isNode(prop.key, 'Identifier')
					? prop.key.name
					: isNode(prop.key, 'Literal')
						? prop.key.value
						: undefined) === '__proto__')
		) {
			throw new Error(
				'Spreads, dynamic keys, prototype setters, methods and accessors are not supported in edited objects.',
			);
		}
		return prop;
	});
	const matches = properties.filter(
		(prop) =>
			String(
				isNode(prop.key, 'Identifier')
					? prop.key.name
					: isNode(prop.key, 'Literal')
						? prop.key.value
						: undefined,
			) === key,
	);
	if (matches.length > 1) throw new Error(`Duplicate property: ${key}`);
	return matches[0];
}

export function editConfig(input: string, options: EditOptions = {}): ConfigEditor {
	return createEditor(input, options).editor;
}

function createEditor(input: string, options: EditOptions) {
	let source = input;
	let ast: Module;
	let comments: Comment[];
	let commas: number[];

	function commit(edits: [number, number, string][]) {
		let next = source;
		for (const [start, end, text] of edits.toReversed().sort((a, b) => b[0] - a[0])) {
			next = next.slice(0, start) + text + next.slice(end);
		}
		const nextComments: Comment[] = [];
		const nextCommas: number[] = [];
		const nextAst = parse(next, options, {
			onComment: nextComments,
			onTrailingComma: (position) => nextCommas.push(position),
		});
		source = next;
		ast = nextAst;
		comments = nextComments;
		commas = nextCommas;
	}
	commit([]);

	function insert(list: ObjectExpression | ArrayExpression, text: string) {
		const items = list.type === 'ArrayExpression' ? list.elements : list.properties;
		if (items.some((item) => item === null))
			throw new Error('Appending to sparse arrays is not supported.');
		if (items.some((item) => item?.type === 'SpreadElement')) {
			throw new Error('Spreads are not supported in edited arrays.');
		}
		const last = items.at(-1);
		const trailing = last && commas.some((pos) => pos >= last.end && pos < list.end);
		const edits: [number, number, string][] = last && !trailing ? [[last.end, last.end, ',']] : [];
		const close = list.end - 1;
		let position = close;
		if (source.slice(list.start, list.end).includes('\n')) {
			const newline = source.includes('\r\n') ? '\r\n' : '\n';
			const lineStart = source.lastIndexOf('\n', close - 1) + 1;
			const beforeClose = source.slice(lineStart, close);
			const closeIndent = beforeClose.match(/^[\t ]*/)![0];
			const firstLine = items[0] ? source.lastIndexOf('\n', items[0].start - 1) + 1 : 0;
			const firstIndent = items[0] ? source.slice(firstLine, items[0].start) : '';
			const indent =
				/^[\t ]+$/.test(firstIndent) && firstIndent.length > closeIndent.length
					? firstIndent
					: `${closeIndent}  `;
			if (/^[\t ]*$/.test(beforeClose)) {
				position = lineStart;
				text = `${indent}${text}${trailing ? ',' : ''}${newline}`;
			} else {
				text = `${newline}${indent}${text}${trailing ? ',' : ''}${newline}${closeIndent}`;
			}
		} else {
			text = `${last ? ' ' : ''}${text}${trailing ? ',' : ''}`;
		}
		edits.push([position, position, text]);
		commit(edits);
	}

	function write(path: readonly string[], value: JsonValue | Expression, append: boolean) {
		if (!Array.isArray(path) || !path.length || path.some((key) => typeof key !== 'string')) {
			throw new TypeError('A path must be a non-empty array of property names.');
		}
		let object = unwrap(
			ast.body.find((node) => isNode(node, 'ExportDefaultDeclaration'))?.declaration,
		);
		if (isNode(object, 'CallExpression')) object = unwrap(object.arguments[0]);
		const rendered = serialize(value);
		for (let i = 0; i < path.length; i++) {
			if (!isNode(object, 'ObjectExpression'))
				throw new Error('The edited path must contain object literals.');
			const prop = property(object, path[i]);
			if (!prop) {
				let text = append ? `[${rendered}]` : rendered;
				for (let j = path.length - 1; j > i; j--) text = `{${propertyName(path[j])}: ${text}}`;
				insert(object, `${propertyName(path[i])}: ${text}`);
				return;
			}
			if (i < path.length - 1) {
				object = unwrap(prop.value);
			} else if (append) {
				const array = unwrap(prop.value);
				if (!isNode(array, 'ArrayExpression'))
					throw new Error('append() requires an array literal.');
				insert(array, rendered);
			} else {
				commit([
					prop.shorthand
						? [prop.start, prop.end, `${source.slice(prop.key.start, prop.key.end)}: ${rendered}`]
						: [prop.value.start, prop.value.end, rendered],
				]);
			}
		}
	}

	const editor: ConfigEditor = {
		get code() {
			return source;
		},
		set(path, value) {
			write(path, value, false);
			return editor;
		},
		append(path, value) {
			write(path, value, true);
			return editor;
		},
		addImport({ from, local, imported = 'default' }) {
			const statement = importStatement({ from, local, imported });
			const imports = ast.body.filter((node) => isNode(node, 'ImportDeclaration'));
			if (
				imports.some(
					(node) =>
						(!('importKind' in node) || node.importKind !== 'type') &&
						node.source.value === from &&
						node.specifiers.some(
							(spec) =>
								(!('importKind' in spec) || spec.importKind !== 'type') &&
								spec.local.name === local &&
								(spec.type === 'ImportDefaultSpecifier'
									? imported === 'default'
									: (isNode(spec, 'ImportSpecifier')
											? isNode(spec.imported, 'Identifier')
												? spec.imported.name
												: spec.imported.value
											: undefined) === imported),
						),
				)
			)
				return editor;
			if (
				imports.some((node) => node.specifiers.some((spec) => spec.local.name === local)) ||
				ast.body.some((node) => {
					const declaration =
						isNode(node, 'ExportNamedDeclaration') || isNode(node, 'ExportDefaultDeclaration')
							? node.declaration
							: node;
					return (
						declaration &&
						'id' in declaration &&
						isNode(declaration.id, 'Identifier') &&
						declaration.id.name === local
					);
				})
			) {
				throw new SyntaxError(`Import name is already declared: ${local}`);
			}
			const previous =
				imports.at(-1) ??
				ast.body.filter((node) => isNode(node, 'ExpressionStatement') && node.directive).at(-1);
			let position = previous?.end ?? ast.body[0]?.start ?? source.length;
			if (previous) {
				for (const comment of comments) {
					if (comment.start >= position && /^[\t ]*$/.test(source.slice(position, comment.start))) {
						position = comment.end;
					}
				}
			}
			const min = previous?.end ?? 0;
			const max = ast.body.find((node) => node.start >= min)?.start ?? source.length;
			const [headerEnd, statementStart] = importCommentRange({ source, ast, comments }, min, max);
			if (headerEnd > statementStart) {
				throw new Error('File and statement comments leave no safe import position.');
			}
			position = Math.max(headerEnd, Math.min(position, statementStart));
			const newline = source.includes('\r\n') ? '\r\n' : '\n';
			const prefix = position && source[position - 1] !== '\n' ? newline : '';
			const suffix = source.slice(position, position + newline.length) === newline ? '' : newline;
			commit([[position, position, `${prefix}${statement}${suffix}`]]);
			return editor;
		},
	};
	return { editor, snapshot: (): Snapshot => ({ source, ast, comments }) };
}

function importStatement({
	from,
	local,
	imported = 'default',
}: {
	from: unknown;
	local: unknown;
	imported?: unknown;
}): string {
	if (typeof from !== 'string' || typeof local !== 'string' || typeof imported !== 'string') {
		throw new TypeError('Import names and module specifiers must be strings.');
	}
	const binding = imported === 'default' ? local : `{ ${JSON.stringify(imported)} as ${local} }`;
	const statement = `import ${binding} from ${JSON.stringify(from)};`;
	const declaration = parse(statement, {}).body;
	if (
		declaration.length !== 1 ||
		!isNode(declaration[0], 'ImportDeclaration') ||
		declaration[0].specifiers.length !== 1 ||
		declaration[0].specifiers[0].local.name !== local
	) {
		throw new SyntaxError('Expected one local import identifier.');
	}
	return statement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	);
}

function isList(value: unknown): value is unknown[] {
	return (
		Array.isArray(value) &&
		Object.getPrototypeOf(value) === Array.prototype &&
		Reflect.ownKeys(value).length === value.length + 1 &&
		Object.keys(value).every(
			(key, index) =>
				key === String(index) && 'value' in Object.getOwnPropertyDescriptor(value, key)!,
		) &&
		Object.keys(value).length === value.length
	);
}

function isJsonValue(value: unknown, ancestors = new Set<unknown>()): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) {
		if (!isList(value)) return false;
	} else if (!isRecord(value)) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Reflect.ownKeys(value).every((key) => {
		if (Array.isArray(value) && key === 'length') return true;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return (
			typeof key === 'string' &&
			descriptor?.enumerable &&
			'value' in descriptor &&
			isJsonValue(descriptor.value, ancestors)
		);
	});
	ancestors.delete(value);
	return valid;
}

function validateOperation(operation: unknown): asserts operation is EditOperation {
	if (!isRecord(operation) || !isJsonValue(operation)) {
		throw new TypeError('Each operation must be a JSON object.');
	}
	const keys =
		operation.op === 'addImport'
			? ['op', 'from', 'local', 'imported', 'expect']
			: ['op', 'path', 'value', 'expression', 'expect'];
	if (Object.keys(operation).some((key) => !keys.includes(key))) {
		throw new TypeError('Unexpected operation field.');
	}
	const expect = operation.expect;
	if (!isRecord(expect)) throw new TypeError('Every operation requires an expect object.');
	const fields = Object.keys(expect);
	const missing = fields.length === 1 && expect.missing === true;
	const valid =
		operation.op === 'addImport'
			? fields.length === 3 &&
				typeof expect.from === 'string' &&
				typeof expect.imported === 'string' &&
				(expect.kind === 'type' || expect.kind === 'value')
			: fields.length === 1 &&
				(Object.hasOwn(expect, 'value') || typeof expect.expression === 'string');
	if (!missing && !valid)
		throw new TypeError(
			'Invalid precondition. Expect missing, a JSON value, an expression, or an import binding.',
		);
	if (operation.op === 'addImport') {
		importStatement({ from: operation.from, local: operation.local, imported: operation.imported });
		return;
	}
	if (operation.op !== 'set' && operation.op !== 'append') {
		throw new TypeError('Expected operation "set", "append" or "addImport".');
	}
	if (
		!isList(operation.path) ||
		!operation.path.length ||
		operation.path.some((key) => typeof key !== 'string')
	) {
		throw new TypeError('A path must be a non-empty array of property names.');
	}
	if (Object.hasOwn(operation, 'value') === Object.hasOwn(operation, 'expression')) {
		throw new TypeError('Specify exactly one of value or expression.');
	}
	if (Object.hasOwn(operation, 'expression') && typeof operation.expression !== 'string') {
		throw new TypeError('Expression must be a string.');
	}
}

export function applyEdits(
	source: string,
	operations: readonly EditOperation[],
	options: EditOptions = {},
): ApplyEditsResult {
	const failure = (
		code: Extract<ApplyEditsResult, { ok: false }>['error']['code'],
		operationIndex: number | null,
		error: unknown,
	): ApplyEditsResult => ({
		ok: false,
		error: {
			code,
			operationIndex,
			message: error instanceof Error ? error.message : String(error),
		},
	});
	try {
		if (typeof source !== 'string' || !isList(operations)) {
			throw new TypeError('Expected source text and an array of operations.');
		}
		validateOptions(options);
	} catch (error) {
		return failure('INVALID_INPUT', null, error);
	}
	for (let i = 0; i < operations.length; i++) {
		try {
			validateOperation(operations[i]);
		} catch (error) {
			return failure('INVALID_INPUT', i, error);
		}
	}
	let state;
	try {
		state = createEditor(source, options);
	} catch (error) {
		return failure('INVALID_SOURCE', null, error);
	}
	const { editor } = state;
	for (let i = 0; i < operations.length; i++) {
		const operation = operations[i];
		let value: JsonValue | Expression | undefined =
			'value' in operation ? operation.value : undefined;
		let valueExpression: Node | undefined;
		let expectedExpression: Node | undefined;
		try {
			if ('expression' in operation && operation.expression !== undefined) {
				const parsed = parseExpression(operation.expression, options);
				value = parsed.value;
				valueExpression = parsed.node;
			}
			if ('expression' in operation.expect && operation.expect.expression !== undefined) {
				expectedExpression = parseExpression(operation.expect.expression, options).node;
			}
		} catch (error) {
			return failure('INVALID_EXPRESSION', i, error);
		}
		const before = state.snapshot();
		try {
			if (!checkPrecondition(before.ast, operation, expectedExpression)) {
				return failure(
					'PRECONDITION_FAILED',
					i,
					new Error('The declared precondition does not match the current target.'),
				);
			}
		} catch (error) {
			return failure('EDIT_FAILED', i, error);
		}
		try {
			if (operation.op === 'addImport') editor.addImport(operation);
			else editor[operation.op](operation.path, value!);
		} catch (error) {
			return failure('EDIT_FAILED', i, error);
		}
		try {
			verifyEdit(before, operation, state.snapshot(), valueExpression);
		} catch (error) {
			return failure('VERIFICATION_FAILED', i, error);
		}
	}
	return { ok: true, code: editor.code, changed: editor.code !== source };
}
