import { applyEdits } from 'kagaru';

const source = `import { defineConfig, type UserConfig } from 'vite';

export default defineConfig({
  // Keep the port aligned with the local API proxy.
  server: { port: 3000 },
  plugins: [],
} satisfies UserConfig);
`;

const operations = JSON.parse(`[
  { "op": "addImport", "from": "@vitejs/plugin-react", "local": "react" },
  { "op": "append", "path": ["plugins"], "expression": "react()" },
  { "op": "set", "path": ["server", "port"], "value": 3001 }
]`);

const result = applyEdits(source, operations, { language: 'ts' });
if (result.ok) {
	console.info(result.code);
} else {
	console.error(result.error);
	process.exitCode = 1;
}
