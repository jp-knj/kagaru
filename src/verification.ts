import type { Node, ObjectExpression, ArrayExpression, Property } from 'acorn';
import { isNode, isObject } from './ast.js';
import type { Module, Snapshot } from './ast.js';
import type { EditOperation, JsonValue, ValueExpectation } from './index.js';

function unwrap(node: Node | null | undefined): Node | undefined {
	while (
		isNode(node, 'ParenthesizedExpression') ||
		isNode(node, 'TSAsExpression') ||
		isNode(node, 'TSSatisfiesExpression')
	) {
		node = node.expression;
	}
	return node ?? undefined;
}

function keyOf(prop: Property): string {
	if (
		prop.method ||
		prop.kind !== 'init' ||
		(prop.computed && (prop.key.type !== 'Literal' || typeof prop.key.value !== 'string'))
	) {
		throw new Error('Expected literal data properties with static keys.');
	}
	const key = isNode(prop.key, 'Identifier')
		? prop.key.name
		: String(isNode(prop.key, 'Literal') ? prop.key.value : undefined);
	if (key === '__proto__' && !prop.computed && !prop.shorthand) {
		throw new Error('Prototype setters are not supported in inspected objects.');
	}
	return key;
}

function properties(node: ObjectExpression): Map<string, Property> {
	const entries = node.properties.map((prop): [string, Property] => {
		if (prop.type !== 'Property')
			throw new Error('Expected literal data properties with static keys.');
		return [keyOf(prop), prop];
	});
	const result = new Map(entries);
	if (result.size !== entries.length)
		throw new Error('Duplicate properties are not supported in inspected objects.');
	return result;
}

function target(
	ast: Module,
	path: readonly string[],
): { object: ObjectExpression; prop: Property | undefined; index: number } {
	let object = unwrap(
		ast.body.find((node) => isNode(node, 'ExportDefaultDeclaration'))?.declaration,
	);
	if (isNode(object, 'CallExpression')) object = unwrap(object.arguments[0]);
	for (let index = 0; ; index++) {
		if (!isNode(object, 'ObjectExpression'))
			throw new Error('Expected an object literal along the edited path.');
		const prop = properties(object).get(path[index]);
		if (!prop || index === path.length - 1) return { object, prop, index };
		object = unwrap(prop.value);
	}
}

function jsonValue(node: Node | null | undefined): JsonValue {
	node = unwrap(node);
	if (
		isNode(node, 'Literal') &&
		(node.value === null ||
			typeof node.value === 'string' ||
			typeof node.value === 'boolean' ||
			typeof node.value === 'number')
	) {
		if (typeof node.value === 'number' && !Number.isFinite(node.value))
			throw new Error('Non-finite literal.');
		return node.value;
	}
	if (
		isNode(node, 'UnaryExpression') &&
		node.operator === '-' &&
		node.argument.type === 'Literal' &&
		typeof node.argument.value === 'number' &&
		Number.isFinite(node.argument.value)
	) {
		return -node.argument.value;
	}
	if (isNode(node, 'ArrayExpression')) return node.elements.map(jsonValue);
	if (isNode(node, 'ObjectExpression')) {
		return Object.fromEntries(
			[...properties(node)].map(([key, prop]) => [key, jsonValue(prop.value)]),
		);
	}
	throw new Error('The expression cannot be read as JSON without execution.');
}

function equal(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
	);
}

function sameTree(a: unknown, b: unknown, omittedA?: Node, omittedB?: Node): boolean {
	while (isNode(a, 'ParenthesizedExpression')) a = a.expression;
	while (isNode(b, 'ParenthesizedExpression')) b = b.expression;
	if (Object.is(a, b)) return true;
	if (!isObject(a) || !isObject(b)) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		const left = a.filter((item) => item !== omittedA);
		const right = b.filter((item) => item !== omittedB);
		return (
			left.length === right.length &&
			left.every((item, index) => sameTree(item, right[index], omittedA, omittedB))
		);
	}
	const keys = (node: Record<string, unknown>) =>
		Object.keys(node).filter(
			(key) =>
				!['start', 'end', 'loc', 'range'].includes(key) &&
				!(key === 'raw' && node.type === 'Literal'),
		);
	const left = keys(a);
	return (
		left.length === keys(b).length &&
		left.every((key) => Object.hasOwn(b, key) && sameTree(a[key], b[key], omittedA, omittedB))
	);
}

function matches(
	node: Node | null | undefined,
	expected: ValueExpectation | Extract<EditOperation, { op: 'set' | 'append' }>,
	expectedExpression?: Node,
): boolean {
	if (!node) return false;
	if (Object.hasOwn(expected, 'expression')) return sameTree(node, expectedExpression);
	try {
		return equal(jsonValue(node), expected.value);
	} catch {
		return false;
	}
}

function imports(ast: Module, local: string) {
	return ast.body
		.filter((node) => isNode(node, 'ImportDeclaration'))
		.flatMap((declaration) =>
			declaration.specifiers
				.filter((spec) => spec.local.name === local)
				.map((spec) => ({
					declaration,
					from: declaration.source.value,
					imported:
						spec.type === 'ImportDefaultSpecifier'
							? 'default'
							: spec.type === 'ImportNamespaceSpecifier'
								? '*'
								: isNode(spec.imported, 'Identifier')
									? spec.imported.name
									: spec.imported.value,
					kind:
						('importKind' in declaration && declaration.importKind === 'type') ||
						('importKind' in spec && spec.importKind === 'type')
							? 'type'
							: 'value',
				})),
		);
}

function binds(pattern: Node | null | undefined, name: string): boolean {
	if (!pattern) return false;
	if (isNode(pattern, 'Identifier')) return pattern.name === name;
	if (isNode(pattern, 'RestElement')) return binds(pattern.argument, name);
	if (isNode(pattern, 'AssignmentPattern')) return binds(pattern.left, name);
	if (isNode(pattern, 'ArrayPattern')) return pattern.elements.some((item) => binds(item, name));
	if (isNode(pattern, 'ObjectPattern'))
		return pattern.properties.some((prop) =>
			binds(prop.type === 'RestElement' ? prop.argument : prop.value, name),
		);
	return false;
}

function declares(node: unknown, name: string, top = true): boolean {
	if (!isObject(node)) return false;
	if (isNode(node, 'ExportNamedDeclaration') || isNode(node, 'ExportDefaultDeclaration'))
		return declares(node.declaration, name, top);
	if (isNode(node, 'ImportDeclaration'))
		return node.specifiers.some((spec) => spec.local.name === name);
	if (isNode(node, 'VariableDeclaration'))
		return (top || node.kind === 'var') && node.declarations.some((decl) => binds(decl.id, name));
	if (top && isNode(node.id, 'Identifier') && node.id.name === name) return true;
	if (typeof node.type === 'string' && /Function|Class|^TS/.test(node.type)) return false;
	return Object.values(node).some((value) =>
		Array.isArray(value)
			? value.some((child) => declares(child, name, false))
			: value && typeof value === 'object' && declares(value, name, false),
	);
}

export function checkPrecondition(
	ast: Module,
	operation: EditOperation,
	expectedExpression?: Node,
): boolean {
	if (operation.op === 'addImport') {
		if (operation.expect.missing) return !ast.body.some((node) => declares(node, operation.local));
		const bindings = imports(ast, operation.local);
		return (
			bindings.length === 1 &&
			(['from', 'imported', 'kind'] as const).every(
				(key) => bindings[0][key] === operation.expect[key],
			)
		);
	}
	const { prop } = target(ast, operation.path);
	return operation.expect.missing
		? !prop
		: matches(prop?.value, operation.expect, expectedExpression);
}

function requireMatch(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function unchanged(before: Snapshot, after: Snapshot, removedBefore?: Node, removedAfter?: Node) {
	requireMatch(
		sameTree(before.ast, after.ast, removedBefore, removedAfter),
		'The edit changed syntax outside its target.',
	);
}

function inserted(
	before: Snapshot,
	after: string,
	start: number,
	end: number,
	min: number,
	max: number,
): boolean {
	const length = after.length - before.source.length;
	if (length <= 0) return false;
	let position = 0;
	while (position < Math.min(start, max) && before.source[position] === after[position]) position++;
	const comment = before.comments.find((item) => item.start < position && position < item.end);
	if (comment) position = comment.start;
	return (
		position >= min &&
		position <= start &&
		position + length >= end &&
		before.source.slice(position) === after.slice(position + length)
	);
}

function insertedItem(
	before: Snapshot,
	after: Snapshot,
	list: ObjectExpression | ArrayExpression,
	item: Node,
) {
	const items = list.type === 'ArrayExpression' ? list.elements : list.properties;
	const min = items.at(-1)?.end ?? list.start + 1;
	const max = list.end - 1;
	let valid = inserted(before, after.source, item.start, item.end, min, max);
	if (!valid && items.length && after.source[min] === ',') {
		valid = inserted(
			before,
			after.source.slice(0, min) + after.source.slice(min + 1),
			item.start - 1,
			item.end - 1,
			min,
			max,
		);
	}
	requireMatch(valid, 'The insertion modified existing source text.');
}

export function verifyEdit(
	before: Snapshot,
	operation: EditOperation,
	after: Snapshot,
	valueExpression?: Node,
): void {
	if (operation.op === 'addImport') {
		const binding = imports(after.ast, operation.local);
		requireMatch(
			binding.length === 1 &&
				binding[0].from === operation.from &&
				binding[0].imported === (operation.imported ?? 'default') &&
				binding[0].kind === 'value',
			'The requested runtime import is missing.',
		);
		if (imports(before.ast, operation.local).length) {
			requireMatch(before.source === after.source, 'An existing import must not modify source.');
			return;
		}
		const added = binding[0].declaration;
		requireMatch(added.specifiers.length === 1, 'The import added unexpected bindings.');
		unchanged(before, after, undefined, added);
		const previous =
			before.ast.body.filter((node) => node.type === 'ImportDeclaration').at(-1) ??
			before.ast.body
				.filter((node) => isNode(node, 'ExpressionStatement') && node.directive)
				.at(-1);
		const min = previous?.end ?? 0;
		const max = before.ast.body.find((node) => node.start >= min)?.start ?? before.source.length;
		requireMatch(
			inserted(before, after.source, added.start, added.end, min, max),
			'The import modified existing source text.',
		);
		return;
	}
	const oldTarget = target(before.ast, operation.path);
	const newTarget = target(after.ast, operation.path);
	requireMatch(
		newTarget.prop && newTarget.index === operation.path.length - 1,
		'The edited property is missing.',
	);
	const value = newTarget.prop.value;
	if (operation.op === 'append') {
		const array = unwrap(value);
		requireMatch(isNode(array, 'ArrayExpression'), 'The appended value is not in an array.');
		requireMatch(
			matches(array.elements.at(-1), operation, valueExpression),
			'The appended value differs from the instruction.',
		);
		if (oldTarget.prop) {
			const oldArray = unwrap(oldTarget.prop.value);
			requireMatch(
				isNode(oldArray, 'ArrayExpression') &&
					array.elements.length === oldArray.elements.length + 1,
				'The array length does not match one append.',
			);
			const added = array.elements.at(-1)!;
			unchanged(before, after, undefined, added);
			insertedItem(before, after, oldArray, added);
			return;
		}
		requireMatch(array.elements.length === 1, 'A new array must contain exactly one item.');
	} else {
		requireMatch(
			matches(value, operation, valueExpression),
			'The written value differs from the instruction.',
		);
	}
	if (oldTarget.prop) {
		unchanged(before, after, oldTarget.prop, newTarget.prop);
		const oldRange = oldTarget.prop.shorthand ? oldTarget.prop : oldTarget.prop.value;
		const newRange = oldTarget.prop.shorthand ? newTarget.prop : newTarget.prop.value;
		requireMatch(
			before.source.slice(0, oldRange.start) === after.source.slice(0, newRange.start) &&
				before.source.slice(oldRange.end) === after.source.slice(newRange.end),
			'The replacement modified existing source text outside its target.',
		);
		return;
	}
	const added = target(after.ast, operation.path.slice(0, oldTarget.index + 1)).prop!;
	let nested = added;
	for (let index = oldTarget.index + 1; index < operation.path.length; index++) {
		const object = unwrap(nested.value);
		requireMatch(
			isNode(object, 'ObjectExpression'),
			'Expected an object literal along the edited path.',
		);
		const entries = properties(object);
		requireMatch(
			entries.size === 1 && entries.has(operation.path[index]),
			'A new parent contains unexpected properties.',
		);
		nested = entries.get(operation.path[index])!;
	}
	unchanged(before, after, undefined, added);
	insertedItem(before, after, oldTarget.object, added);
}
