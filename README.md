# Kagaru

**JSON instructions for small edits to JavaScript and TypeScript configs.**

An AI generates edit instructions; your application supplies the original source
to Kagaru. Kagaru applies those instructions while retaining comments, formatting
and types outside the edited ranges. It validates syntax without executing the
config or loading its imports.

The name comes from the Japanese verb _kagaru_ (かがる), to stitch: an edit joins
new code to the surrounding text. Source ranges drive each change, with no
whole-file printer or build step.

This is an unpublished prototype. The package remains private.

## Try it

```sh
git clone https://github.com/jp-knj/kagaru.git
cd kagaru
pnpm install --frozen-lockfile
pnpm test
pnpm test:types
pnpm demo
```

## Apply instructions from an AI

Ask the AI for an array of operations matching `kagaru/operations.schema.json`:

```json
[
  { "op": "addImport", "from": "@vitejs/plugin-react", "local": "react" },
  { "op": "append", "path": ["plugins"], "expression": "react()" },
  { "op": "set", "path": ["server", "port"], "value": 3001 }
]
```

Pass the parsed array and the original source to `applyEdits()`:

```js
import { applyEdits } from 'kagaru';

const source = `import { defineConfig, type UserConfig } from 'vite';

export default defineConfig({
  // Keep the port aligned with the local API proxy.
  server: { port: 3000 },
  plugins: [],
} satisfies UserConfig);
`;

const result = applyEdits(source, [
  { op: 'addImport', from: '@vitejs/plugin-react', local: 'react' },
  { op: 'append', path: ['plugins'], expression: 'react()' },
  { op: 'set', path: ['server', 'port'], value: 3001 },
], { language: 'ts' });

if (result.ok) {
  console.info(result.code);
} else {
  console.error(result.error);
}
```

The example edits Vite config text without requiring Vite or React. Callers own
file reading, JSON parsing and file writing, so they can review the returned
string before saving it. Kagaru has no CLI, MCP server or LLM SDK dependency.

## Operations

| Operation | Fields | Behavior |
| --- | --- | --- |
| `set` | `path`, either `value` or `expression` | Replace or create a property. Create missing parent objects. |
| `append` | `path`, either `value` or `expression` | Append one item to an array literal. Create missing objects and arrays. |
| `addImport` | `from`, `local`, optional `imported` | Add a default or named runtime import. `imported` defaults to `"default"`. |

Paths are non-empty arrays of property names. `['a.b']` addresses one property;
`['a', 'b']` addresses a nested property. Empty property names are allowed. Array
indices are not supported.

Use `value` for JSON data, including nested objects and arrays. Use `expression`
for one expression, such as `react()`, an identifier or a regular expression.
The expression uses the selected language. Supplying both fields or neither is
an error. Unknown operations, extra fields, invalid paths and non-JSON values
are rejected. Non-JSON values include `undefined`, non-finite numbers, bigint,
functions, cycles, sparse arrays and objects with accessors or custom prototypes.

An import is a duplicate only when its module, imported name and local name
match an existing runtime import. A type-only import is never reused as a runtime
import. A conflicting local name is an error; use a different local name instead.
Imports are added as separate declarations, preserving existing import text.

## Results and errors

`applyEdits(source, operations, options?)` is synchronous. It validates all
instruction shapes, parses the source, then applies operations in order.

```ts
type ApplyEditsResult =
  | { ok: true; code: string; changed: boolean }
  | {
      ok: false;
      error: {
        code: 'INVALID_INPUT' | 'INVALID_SOURCE' | 'INVALID_EXPRESSION' | 'EDIT_FAILED';
        operationIndex: number | null;
        message: string;
      };
    };
```

`changed` compares the final code with the original source. Empty operation arrays
and exact duplicate imports can return `changed: false`. Failure results contain
no code, including when earlier operations succeeded.

| Error code | Meaning | `operationIndex` |
| --- | --- | --- |
| `INVALID_INPUT` | Invalid arguments, options or instruction shape | Zero-based operation index, or `null` for whole-input errors |
| `INVALID_SOURCE` | Source cannot be parsed in the selected language | `null` |
| `INVALID_EXPRESSION` | Expression text cannot be parsed as one expression | Zero-based operation index |
| `EDIT_FAILED` | Unsupported target, import collision or invalid resulting module | Zero-based operation index |

The package exports `EditOptions`, `EditOperation`, `ApplyEditsResult`, `JsonValue`,
`Expression` and `ConfigEditor` types. The JSON Schema uses draft 2020-12 and
describes the operation array. Syntax checks for expressions and local import
identifiers are performed by Kagaru, beyond the schema's shape validation.
Runtime input validation has no additional dependency.

## Language and editing scope

All entry points accept `{ language: 'js' | 'ts' }`; the default is `'js'`.
TypeScript mode supports type annotations, type-only imports, `as const`,
`satisfies` and calls with type arguments. It checks syntax, without type checking
or executing source or expression code.

The editable default export must be an object literal, or a call whose first
argument is an object literal, such as `defineConfig<Config>({ ... })`. Parentheses,
`as` and `satisfies` wrappers around these targets are supported. Nested objects
and arrays can also have these wrappers.

Text outside the edited ranges is retained verbatim. New entries use existing
list indentation and LF or CRLF where possible. Generated strings and property
names use double quotes. Replacing a value also replaces comments and type
assertions inside that value. Appending to an asserted array retains its assertion.

- No variable resolution, computed property evaluation or function-body editing.
- Objects along the edited path cannot contain spreads, computed keys, methods or
  accessors. Duplicate target keys are rejected.
- Arrays can be appended to, but sparse arrays and arrays with spreads are rejected.
- Imports support default and named bindings. Adding namespace imports and merging
  declarations are not implemented.
- CommonJS editing, JSX and TSX are outside the supported scope.
- No source maps, full formatting inference or magicast API compatibility.
- Every edit reparses the module. Kagaru is intended for small configuration files.

## Fluent editor

The original API is available for application-authored edits. Its methods throw
on errors and commit each successful operation separately. A failed operation
leaves earlier successful edits in place.

```js
import { editConfig, expression } from 'kagaru';

const options = { language: 'ts' };
const config = editConfig('export default {} satisfies Config;', options);
config
  .addImport({ from: '@vitejs/plugin-react', local: 'react' })
  .append(['plugins'], expression('react()', options))
  .set(['server', 'port'], 3001);

console.info(config.code);
```

`expression(code, options?)` validates one expression for insertion. Pass the
result directly to `.set()` or `.append()`; do not nest it inside JSON data.
Fluent values retain the original `JSON.stringify()` behavior. `applyEdits()`
uses the stricter JSON validation described above.

## Installed size

Kagaru's runtime dependencies are Acorn and `@sveltejs/acorn-typescript`.
Development-only schema and declaration checks use Ajv and TypeScript.

The packed package is checked in a fresh consumer project with production
dependencies only. Size is measured as the sum of logical package-file bytes,
excluding filesystem blocks, package-manager metadata and the shared store.
The measured total is approximately **0.81 MB across three packages**, below the
1 MB target: Kagaru 0.0.0, Acorn 8.19.0 and `@sveltejs/acorn-typescript` 1.0.13.
This is an installed-size measurement, not a download-size or speed benchmark.
