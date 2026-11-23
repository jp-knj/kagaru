import { Parser } from 'acorn';
import { tsPlugin } from '@sveltejs/acorn-typescript';

const parserOptions = { ecmaVersion: 'latest', sourceType: 'module', preserveParens: true };
const TypeScriptParser = Parser.extend(tsPlugin({ jsx: false }));

function parse(source, options, callbacks = {}) {
	if (typeof source !== 'string') throw new TypeError('Source must be a string.');
	validateOptions(options);
	return options.language === 'ts'
		? TypeScriptParser.parse(source, { ...parserOptions, locations: true, ...callbacks })
		: Parser.parse(source, { ...parserOptions, ...callbacks });
}

function validateOptions(options) {
	if (
		!isRecord(options) ||
		Reflect.ownKeys(options).some((key) => key !== 'language') ||
		(options.language !== undefined && options.language !== 'js' && options.language !== 'ts')
	) {
		throw new TypeError('Expected options with language "js" or "ts".');
	}
}

class Expression {
	constructor(code) {
		this.code = code;
	}
}

export function expression(code, options = {}) {
	if (typeof code !== 'string') throw new TypeError('Expression must be a string.');
	const comments = [];
	const wrapped = `(\n${code}\n)`;
	const ast = parse(wrapped, options, { onComment: comments });
	const root = ast.body[0]?.expression;
	if (
		ast.body.length !== 1 ||
		root?.type !== 'ParenthesizedExpression' ||
		root.end !== wrapped.length
	) {
		throw new SyntaxError('Expected one expression.');
	}
	const node = root.expression;
	const trailingLineComment = comments.some(
		(comment) => comment.type === 'Line' && code.slice(comment.end - 2).trim() === '',
	);
	return new Expression(
		node.type === 'SequenceExpression' ? `(${code}\n)` : code + (trailingLineComment ? '\n' : ''),
	);
}

function serialize(value) {
	if (value instanceof Expression) return value.code;
	const code = JSON.stringify(value);
	if (code === undefined) throw new TypeError('Use expression() for non-JSON values.');
	return code;
}

function unwrap(node) {
	while (
		node?.type === 'ParenthesizedExpression' ||
		node?.type === 'TSAsExpression' ||
		node?.type === 'TSSatisfiesExpression'
	)
		node = node.expression;
	return node;
}

function property(object, key) {
	if (object?.type !== 'ObjectExpression') {
		throw new Error('The edited path must contain object literals.');
	}
	if (
		object.properties.some(
			(prop) => prop.type !== 'Property' || prop.computed || prop.method || prop.kind !== 'init',
		)
	) {
		throw new Error(
			'Spreads, computed keys, methods and accessors are not supported in edited objects.',
		);
	}
	const matches = object.properties.filter(
		(prop) => String(prop.key.name ?? prop.key.value) === key,
	);
	if (matches.length > 1) throw new Error(`Duplicate property: ${key}`);
	return matches[0];
}

export function editConfig(input, options = {}) {
	let source = input;
	let ast;
	let comments;
	let commas;

	function commit(edits) {
		let next = source;
		for (const [start, end, text] of edits.toReversed().sort((a, b) => b[0] - a[0])) {
			next = next.slice(0, start) + text + next.slice(end);
		}
		const nextComments = [];
		const nextCommas = [];
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

	function insert(list, text) {
		const items = list.type === 'ArrayExpression' ? list.elements : list.properties;
		if (items.includes(null)) throw new Error('Appending to sparse arrays is not supported.');
		if (items.some((item) => item.type === 'SpreadElement')) {
			throw new Error('Spreads are not supported in edited arrays.');
		}
		const last = items.at(-1);
		const trailing = last && commas.some((pos) => pos >= last.end && pos < list.end);
		const edits = last && !trailing ? [[last.end, last.end, ',']] : [];
		const close = list.end - 1;
		let position = close;
		if (source.slice(list.start, list.end).includes('\n')) {
			const newline = source.includes('\r\n') ? '\r\n' : '\n';
			const lineStart = source.lastIndexOf('\n', close - 1) + 1;
			const beforeClose = source.slice(lineStart, close);
			const closeIndent = beforeClose.match(/^[\t ]*/)[0];
			const firstLine = items[0] && source.lastIndexOf('\n', items[0].start - 1) + 1;
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

	function write(path, value, append) {
		if (!Array.isArray(path) || !path.length || path.some((key) => typeof key !== 'string')) {
			throw new TypeError('A path must be a non-empty array of property names.');
		}
		let object = unwrap(
			ast.body.find((node) => node.type === 'ExportDefaultDeclaration')?.declaration,
		);
		if (object?.type === 'CallExpression') object = unwrap(object.arguments[0]);
		const rendered = serialize(value);
		for (let i = 0; i < path.length; i++) {
			const prop = property(object, path[i]);
			if (!prop) {
				let text = append ? `[${rendered}]` : rendered;
				for (let j = path.length - 1; j > i; j--) text = `{${JSON.stringify(path[j])}: ${text}}`;
				insert(object, `${JSON.stringify(path[i])}: ${text}`);
				return;
			}
			if (i < path.length - 1) {
				object = unwrap(prop.value);
			} else if (append) {
				const array = unwrap(prop.value);
				if (array.type !== 'ArrayExpression')
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

	const editor = {
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
			const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
			if (
				imports.some(
					(node) =>
						node.importKind !== 'type' &&
						node.source.value === from &&
						node.specifiers.some(
							(spec) =>
								spec.importKind !== 'type' &&
								spec.local.name === local &&
								(spec.type === 'ImportDefaultSpecifier'
									? imported === 'default'
									: (spec.imported?.name ?? spec.imported?.value) === imported),
						),
				)
			)
				return editor;
			if (
				imports.some((node) => node.specifiers.some((spec) => spec.local.name === local)) ||
				ast.body.some((node) => (node.declaration ?? node).id?.name === local)
			) {
				throw new SyntaxError(`Import name is already declared: ${local}`);
			}
			const previous = imports.at(-1) ?? ast.body.filter((node) => node.directive).at(-1);
			let position = previous?.end ?? ast.body[0]?.start ?? source.length;
			if (previous) {
				for (const comment of comments) {
					if (comment.start >= position && /^[\t ]*$/.test(source.slice(position, comment.start))) {
						position = comment.end;
					}
				}
			}
			const newline = source.includes('\r\n') ? '\r\n' : '\n';
			const prefix = position && source[position - 1] !== '\n' ? newline : '';
			const suffix = source.slice(position, position + newline.length) === newline ? '' : newline;
			commit([[position, position, `${prefix}${statement}${suffix}`]]);
			return editor;
		},
	};
	return editor;
}

function importStatement({ from, local, imported = 'default' }) {
	if (typeof from !== 'string' || typeof local !== 'string' || typeof imported !== 'string') {
		throw new TypeError('Import names and module specifiers must be strings.');
	}
	const binding = imported === 'default' ? local : `{ ${JSON.stringify(imported)} as ${local} }`;
	const statement = `import ${binding} from ${JSON.stringify(from)};`;
	const declaration = parse(statement, {}).body;
	if (
		declaration.length !== 1 ||
		declaration[0].type !== 'ImportDeclaration' ||
		declaration[0].specifiers.length !== 1 ||
		declaration[0].specifiers[0].local.name !== local
	) {
		throw new SyntaxError('Expected one local import identifier.');
	}
	return statement;
}

function isRecord(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	);
}

function isList(value) {
	return (
		Array.isArray(value) &&
		Object.getPrototypeOf(value) === Array.prototype &&
		Reflect.ownKeys(value).length === value.length + 1 &&
		Object.keys(value).every(
			(key, index) =>
				key === String(index) && 'value' in Object.getOwnPropertyDescriptor(value, key),
		) &&
		Object.keys(value).length === value.length
	);
}

function isJsonValue(value, ancestors = new Set()) {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (!(Array.isArray(value) ? isList(value) : isRecord(value)) || ancestors.has(value))
		return false;
	ancestors.add(value);
	const valid = Reflect.ownKeys(value).every((key) => {
		if (Array.isArray(value) && key === 'length') return true;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return (
			typeof key === 'string' &&
			descriptor.enumerable &&
			'value' in descriptor &&
			isJsonValue(descriptor.value, ancestors)
		);
	});
	ancestors.delete(value);
	return valid;
}

function validateOperation(operation) {
	if (!isRecord(operation) || !isJsonValue(operation)) {
		throw new TypeError('Each operation must be a JSON object.');
	}
	const keys =
		operation.op === 'addImport'
			? ['op', 'from', 'local', 'imported']
			: ['op', 'path', 'value', 'expression'];
	if (Object.keys(operation).some((key) => !keys.includes(key))) {
		throw new TypeError('Unexpected operation field.');
	}
	if (operation.op === 'addImport') {
		importStatement(operation);
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

export function applyEdits(source, operations, options = {}) {
	const failure = (code, operationIndex, error) => ({
		ok: false,
		error: { code, operationIndex, message: error.message },
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
	let editor;
	try {
		editor = editConfig(source, options);
	} catch (error) {
		return failure('INVALID_SOURCE', null, error);
	}
	for (let i = 0; i < operations.length; i++) {
		const operation = operations[i];
		let value = operation.value;
		if (Object.hasOwn(operation, 'expression')) {
			try {
				value = expression(operation.expression, options);
			} catch (error) {
				return failure('INVALID_EXPRESSION', i, error);
			}
		}
		try {
			if (operation.op === 'addImport') editor.addImport(operation);
			else editor[operation.op](operation.path, value);
		} catch (error) {
			return failure('EDIT_FAILED', i, error);
		}
	}
	return { ok: true, code: editor.code, changed: editor.code !== source };
}
