import { expression, editConfig } from 'kagaru';

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
