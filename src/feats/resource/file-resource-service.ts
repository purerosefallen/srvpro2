import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Context } from '../../app';
import { cloneJson, isObjectRecord } from './resource-util';

export class FileResourceService {
  private logger = this.ctx.createLogger(this.constructor.name);

  private readonly dataDir = path.resolve(process.cwd(), 'data');
  private readonly defaultDataPath = path.resolve(
    process.cwd(),
    'resource',
    'default_data.json',
  );

  private initialized = false;
  private initTask?: Promise<void>;

  private dataByName = new Map<string, Record<string, unknown>>();
  private dataPathByName = new Map<string, string>();

  constructor(private ctx: Context) {}

  async init() {
    await this.ensureInitialized();
  }

  async ensureInitialized() {
    if (this.initialized) {
      return;
    }
    if (!this.initTask) {
      this.initTask = this.doInit();
    }
    await this.initTask;
  }

  getDataOrEmpty<T extends object>(name: string, emptyData: T): T {
    if (!this.initialized) {
      return cloneJson(emptyData);
    }
    const data = this.dataByName.get(name);
    if (!data) {
      return cloneJson(emptyData);
    }
    return cloneJson(data as T);
  }

  async saveData(name: string, data: Record<string, unknown>) {
    await this.ensureInitialized();
    const dataPath = this.dataPathByName.get(name);
    if (!dataPath) {
      return false;
    }
    await fs.writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    this.dataByName.set(name, cloneJson(data));
    return true;
  }

  private async doInit() {
    await fs.mkdir(this.dataDir, { recursive: true });

    const defaultData = await this.readJsonFile(this.defaultDataPath);
    if (!isObjectRecord(defaultData)) {
      this.logger.warn(
        { defaultDataPath: this.defaultDataPath },
        'Failed to load resource/default_data.json',
      );
      this.initialized = true;
      return;
    }

    for (const [name, data] of Object.entries(defaultData)) {
      if (!isObjectRecord(data)) {
        continue;
      }
      const resolvedData = this.resolveDefaultData(name, data);
      const dataPath = this.resolveDataPath(name, data.file);
      this.dataPathByName.set(name, dataPath);

      const localData = await this.readJsonFile(dataPath);
      if (isObjectRecord(localData)) {
        this.dataByName.set(name, localData);
        continue;
      }

      await fs.writeFile(
        dataPath,
        JSON.stringify(resolvedData, null, 2),
        'utf-8',
      );
      this.dataByName.set(name, resolvedData);
    }

    this.initialized = true;
    this.logger.info(
      { count: this.dataByName.size, dataDir: this.dataDir },
      'File resources initialized',
    );
  }

  private resolveDefaultData(name: string, data: Record<string, unknown>) {
    const nextData = cloneJson(data);
    const fileName = this.resolveFileName(name, data.file);
    nextData.file = `./data/${fileName}`;
    return nextData;
  }

  private resolveDataPath(name: string, filePath: unknown) {
    const fileName = this.resolveFileName(name, filePath);
    return path.join(this.dataDir, fileName);
  }

  private resolveFileName(name: string, filePath: unknown) {
    if (typeof filePath === 'string' && filePath.trim()) {
      return path.basename(filePath);
    }
    return `${name}.json`;
  }

  private async readJsonFile(filePath: string): Promise<unknown> {
    try {
      const text = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}
