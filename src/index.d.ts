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

export function expression(code: string, options?: EditOptions): Expression;
export function editConfig(source: string, options?: EditOptions): ConfigEditor;
export function applyEdits(
	source: string,
	operations: readonly EditOperation[],
	options?: EditOptions,
): ApplyEditsResult;
