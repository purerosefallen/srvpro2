import * as fs from 'fs';
import yaml from 'yaml';
import { configurer } from '../config';

async function main(): Promise<void> {
  const exampleConfig = configurer.generateExampleObject();
  // Keep trailing space for tips prefix to match srvpro behavior.
  exampleConfig.tipsPrefix = 'Tip: ';
  const output = yaml.stringify(exampleConfig);
  await fs.promises.writeFile('./config.example.yaml', output, 'utf-8');
  console.log('Generated config.example.yaml');
}

main().catch((error) => {
  console.error(`Failed to generate config.example.yaml: ${error}`);
  process.exitCode = 1;
});
