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

export interface ConfigEditor {
	readonly code: string;
	set(path: readonly string[], value: JsonValue | Expression): this;
	append(path: readonly string[], value: JsonValue | Expression): this;
	addImport(options: { from: string; local: string; imported?: string }): this;
}

export function expression(code: string): Expression;
export function editConfig(source: string): ConfigEditor;
