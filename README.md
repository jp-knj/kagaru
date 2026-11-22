# Kagaru

**Small edits for human-written configs.**

Kagaru edits JavaScript configuration files while retaining the source text
outside each requested change. The name comes from the Japanese verb _kagaru_
(かがる), to stitch: an edit joins new code to the surrounding text.

It is built for CLI installers, project generators and upgrade tools that need
to add an import, enable a plugin or change a nested setting. Those tools should
produce small, reviewable diffs, even when the config contains handwritten
comments and formatting.

## Design principles

- **Preserve the author's text.** Replace the requested value or insert a new
  entry; keep unrelated source byte for byte. Comments inside a replaced value
  are replaced with that value.
- **Make each edit explicit.** Use property paths with `set()` and `append()`.
  Validate syntax without executing the config. Reject unsupported targets
  without changing the source for that operation.
- **Keep installation small.** Acorn is the only dependency. Source ranges drive
  edits directly, with no whole-file printer, runtime code generation or build
  step.

The initial scope is JavaScript ESM configuration with a default exported object,
optionally wrapped in a call such as `defineConfig({ ... })`. TypeScript input and
variable resolution are outside this prototype's scope.

This is an unpublished prototype. The package is marked private to prevent
accidental npm publication.

## Try it

```sh
git clone https://github.com/jp-knj/kagaru.git
cd kagaru
pnpm install --frozen-lockfile
pnpm test
pnpm demo
```

There is no build step. The published entry point would be the same JavaScript
that the tests exercise. TypeScript declarations are included for callers.

```js
import { editConfig, expression } from 'kagaru';

const config = editConfig(`import { defineConfig } from 'vite';

export default defineConfig({
  // Keep the port aligned with the local API proxy.
  server: { port: 3000 },
  plugins: [],
});
`);

config
  .addImport({ from: '@vitejs/plugin-react', local: 'react' })
  .append(['plugins'], expression('react()'))
  .set(['server', 'port'], 3001);

console.info(config.code);
```

The example edits Vite config text; running it does not require Vite or React.
Callers own file reading and writing, so they can preview the returned string
before saving it.

## API

| API                                      | Behavior                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editConfig(source)`                     | Create a config editor from JavaScript ES module source without executing it.                                                                     |
| `.set(path, value)`                      | Replace or create a property in the default exported object. Missing parent objects are created.                                                  |
| `.append(path, value)`                   | Append to an array literal, creating missing objects and arrays.                                                                                  |
| `.addImport({ from, local, imported? })` | Add a separate import declaration. `imported` defaults to `'default'`; a named export can also be specified. Exact duplicate imports are ignored. |
| `.code`                                  | Return the current source string.                                                                                                                 |
| `expression(source)`                     | Validate a single JavaScript expression for insertion without executing it.                                                                       |

Paths are arrays of property names, so `['a.b']` addresses one property and
`['a', 'b']` addresses a nested property. Values use `JSON.stringify()` semantics.
For JavaScript calls, identifiers, regular expressions or other non-JSON values,
wrap the entire value in `expression()`. Do not nest expressions inside JSON data.

The editable default export must be an object literal, or a call whose first
argument is an object literal, such as `defineConfig({ ... })`. Parentheses around
these objects are supported. Input code is never imported or evaluated.

## How it stays small

Acorn supplies syntax validation and source ranges. Edits splice only the affected
ranges of the original string, then reparse the result before committing it. A
failed operation leaves the source unchanged. There is no AST printer, proxy
layer, formatter, filesystem wrapper or build tool in the package.

Text outside the edited ranges is retained verbatim, including comments. New
entries use simple formatting, matching existing list indentation and LF or CRLF
where possible. Generated strings and property names use double quotes. Editing
an existing value replaces the comments inside that value along with the value.

## Deliberate limits

- JavaScript ESM only. TypeScript and JSX input are rejected.
- No variable resolution, computed property evaluation or function-body editing.
- Objects along the edited path cannot contain spreads, computed keys, methods or
  accessors. Duplicate target keys are rejected.
- Arrays can be appended to, but individual indices cannot be edited. Sparse
  arrays cannot be appended to.
- Imports support default and named bindings. Namespace imports and merging
  declarations are not implemented.
- No source maps, CommonJS editing, full formatting inference or magicast API
  compatibility.
- Every edit reparses the module. This is intended for small configuration files,
  not bulk transformation of large source files.

These limits reduce the implementation and dependency footprint. A size comparison
with magicast must account for the smaller feature set.

## Initial size comparison

Two fresh consumer projects were installed from a local pnpm store on macOS
ARM64. The prototype was installed from its packed tarball. The numbers sum the
logical sizes of package files, including dependencies, rather than filesystem
blocks, pnpm's shared store, or download sizes.

| Package                        | Installed packages, including itself | Installed files |
| ------------------------------ | -----------------------------------: | --------------: |
| magicast 0.5.5                 |                                    6 |         5.44 MB |
| kagaru 0.0.0 with Acorn 8.19.0 |                                    2 |         0.58 MB |

That is approximately 89% fewer bytes for this deliberately smaller API. It is
not a claim of feature equivalence or an install-time benchmark.
