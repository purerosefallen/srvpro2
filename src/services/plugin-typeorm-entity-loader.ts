import fs from 'node:fs';
import path from 'node:path';
import { getMetadataArgsStorage } from 'typeorm';

type PluginEntityLogger = {
  warn: (...args: unknown[]) => void;
};

export function collectPluginTypeormEntities(logger?: PluginEntityLogger): Function[] {
  const pluginDir = path.resolve(__dirname, '..', '..', 'plugins');
  const pluginEntityFiles = collectPluginEntityFiles(pluginDir);
  const entities = new Set<Function>();

  for (const pluginEntityFile of pluginEntityFiles) {
    const requirePath = resolveRequirePath(pluginEntityFile);

    let loadedModule: unknown;
    try {
      loadedModule = require(requirePath);
    } catch (error) {
      logger?.warn(
        {
          pluginEntityFile: requirePath,
          error: (error as Error)?.stack || String(error),
        },
        'Failed requiring plugin entity file',
      );
      continue;
    }

    const exportedItems = resolveExportedItems(loadedModule);
    const entityTargets = collectTypeormEntityTargets();
    for (const item of exportedItems) {
      if (typeof item !== 'function') {
        continue;
      }
      if (!entityTargets.has(item)) {
        continue;
      }
      entities.add(item);
    }
  }

  return [...entities];
}

function collectPluginEntityFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!fullPath.endsWith('.entity.js')) {
        continue;
      }
      files.push(fullPath);
    }
  };

  walk(rootDir);
  return files;
}

function resolveRequirePath(filePath: string) {
  const cwdRelative = path.relative(process.cwd(), filePath);
  return path.resolve(process.cwd(), cwdRelative);
}

function collectTypeormEntityTargets() {
  const targets = new Set<Function>();
  for (const table of getMetadataArgsStorage().tables) {
    if (table.type === 'view') {
      continue;
    }
    if (typeof table.target !== 'function') {
      continue;
    }
    targets.add(table.target);
  }
  return targets;
}

function resolveExportedItems(loadedModule: unknown) {
  const items: unknown[] = [];
  if (!loadedModule) {
    return items;
  }
  if (typeof loadedModule === 'function') {
    items.push(loadedModule);
    return items;
  }
  if (typeof loadedModule !== 'object') {
    return items;
  }
  const record = loadedModule as Record<string, unknown>;
  if (record.default) {
    items.push(record.default);
  }
  for (const value of Object.values(record)) {
    items.push(value);
  }
  return items;
}
