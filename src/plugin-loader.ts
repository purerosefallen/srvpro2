import { createAppContext } from 'nfkit';
import { ContextState } from './app';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { reflector } from './utility/metadata';

export const PluginLoader = () => {
  const ctx = createAppContext<ContextState>();
  const logger = pino({
    name: 'PluginLoader',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  });
  const pluginDir = path.resolve(__dirname, '../plugins');
  const pluginFiles = collectPluginFiles(pluginDir);
  const providedClasses = new Set<Function>();
  const loadedPluginNames = new Set<string>();

  for (const pluginFile of pluginFiles) {
    const cwdRelative = path.relative(process.cwd(), pluginFile);
    const requirePath = path.resolve(process.cwd(), cwdRelative);

    let loadedModule: unknown;
    try {
      loadedModule = require(requirePath);
    } catch (error) {
      logger.warn(
        {
          pluginFile: requirePath,
          error: (error as Error)?.stack || String(error),
        },
        'Failed requiring plugin file',
      );
      continue;
    }

    const exportedItems = resolveExportedItems(loadedModule);
    for (const item of exportedItems) {
      if (typeof item !== 'function' || providedClasses.has(item)) {
        continue;
      }
      const pluginName = reflector.get('plugin', item);
      if (!pluginName) {
        continue;
      }
      if (loadedPluginNames.has(pluginName)) {
        logger.warn(
          {
            pluginFile: requirePath,
            plugin: pluginName,
          },
          'Skipped duplicate plugin name',
        );
        continue;
      }
      providedClasses.add(item);
      loadedPluginNames.add(pluginName);
      ctx.provide(item as any);
      logger.info(
        {
          pluginFile: requirePath,
          plugin: pluginName,
        },
        'Loaded plugin provider',
      );
    }
  }

  return ctx;
};

function collectPluginFiles(rootDir: string): string[] {
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
      if (!fullPath.endsWith('.js') && !fullPath.endsWith('.cjs')) {
        continue;
      }
      files.push(fullPath);
    }
  };
  walk(rootDir);
  return files;
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
