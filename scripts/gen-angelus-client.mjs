import { createClient } from '@hey-api/openapi-ts';

const response = await fetch('http://localhost:3001/docs-json');
if (!response.ok)
  throw new Error('Angelus OpenAPI returned ' + response.status);
const spec = await response.json();
const paths = {};
for (const [path, method] of [
  ['/lflists', 'get'],
  ['/card-data', 'get'],
  ['/check-deck', 'post'],
]) {
  if (!spec.paths[path]?.[method])
    throw new Error('Missing Angelus operation ' + path);
  paths[path] = { [method]: spec.paths[path][method] };
}
await createClient({
  input: { ...spec, paths },
  output: 'src/angelus/generated',
  plugins: ['@hey-api/typescript', '@hey-api/client-axios', '@hey-api/sdk'],
});
