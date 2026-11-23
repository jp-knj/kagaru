import type { AnyNode, Comment, Node, Program } from 'acorn';

type TypeScriptWrapper = {
	[Type in 'TSAsExpression' | 'TSSatisfiesExpression']: Node & {
		type: Type;
		expression: Node;
	};
}['TSAsExpression' | 'TSSatisfiesExpression'];

type KnownNode = AnyNode | TypeScriptWrapper;

export type Module = Omit<Program, 'body'> & { body: Node[] };

export interface Snapshot {
	source: string;
	ast: Module;
	comments: Comment[];
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

export function isNode<Type extends KnownNode['type']>(
	node: unknown,
	type: Type,
): node is Extract<KnownNode, { type: Type }> {
	return isObject(node) && node.type === type;
}
