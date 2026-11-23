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

export type EditOperation =
	| ({ op: 'set' | 'append'; path: readonly [string, ...string[]] } & (
			| { value: JsonValue; expression?: never }
			| { expression: string; value?: never }
	  ))
	| { op: 'addImport'; from: string; local: string; imported?: string };

export type ApplyEditsResult =
	| { ok: true; code: string; changed: boolean }
	| {
			ok: false;
			error: {
				code: 'INVALID_INPUT' | 'INVALID_SOURCE' | 'INVALID_EXPRESSION' | 'EDIT_FAILED';
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

export function expression(code: string, options?: EditOptions): Expression;
export function editConfig(source: string, options?: EditOptions): ConfigEditor;
export function applyEdits(
	source: string,
	operations: readonly EditOperation[],
	options?: EditOptions,
): ApplyEditsResult;
