import { parse } from 'acorn';

const parserOptions = { ecmaVersion: 'latest', sourceType: 'module', preserveParens: true };

class Expression {
	constructor(code) {
		this.code = code;
	}
}

export function expression(code) {
	const comments = [];
	const wrapped = `(\n${code}\n)`;
	const ast = parse(wrapped, { ...parserOptions, onComment: comments });
	const root = ast.body[0]?.expression;
	if (
		ast.body.length !== 1 ||
		root?.type !== 'ParenthesizedExpression' ||
		root.end !== wrapped.length
	) {
		throw new SyntaxError('Expected one JavaScript expression.');
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
	while (node?.type === 'ParenthesizedExpression') node = node.expression;
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

export function editConfig(input) {
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
		const nextAst = parse(next, {
			...parserOptions,
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
			const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
			if (
				imports.some(
					(node) =>
						node.source.value === from &&
						node.specifiers.some(
							(spec) =>
								spec.local.name === local &&
								(spec.type === 'ImportDefaultSpecifier'
									? imported === 'default'
									: (spec.imported?.name ?? spec.imported?.value) === imported),
						),
				)
			)
				return editor;
			if (typeof from !== 'string' || typeof local !== 'string' || typeof imported !== 'string') {
				throw new TypeError('Import names and module specifiers must be strings.');
			}
			const binding =
				imported === 'default' ? local : `{ ${JSON.stringify(imported)} as ${local} }`;
			const statement = `import ${binding} from ${JSON.stringify(from)};`;
			const declaration = parse(statement, parserOptions).body;
			if (
				declaration.length !== 1 ||
				declaration[0].type !== 'ImportDeclaration' ||
				declaration[0].specifiers.length !== 1 ||
				declaration[0].specifiers[0].local.name !== local
			) {
				throw new SyntaxError('Expected one local import identifier.');
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
