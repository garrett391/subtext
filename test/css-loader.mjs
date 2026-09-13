// Node can't import a stylesheet. Vite strips that import at build time; here
// it is turned into an empty module so main.js can be loaded as-is.
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return nextLoad(url, context);
}
