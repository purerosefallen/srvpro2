import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileResourceService } from '../src/file-resource';
import { EMPTY_DIALOGUES_DATA } from '../src/feats/resource/types';

function makeCtx() {
  return {
    get: (factory: () => unknown) => {
      const token = factory();
      switch ((token as any)?.name) {
        case 'Logger':
          return {
            createLogger: () => ({
              info: jest.fn(),
              warn: jest.fn(),
            }),
          };
        default:
          return undefined;
      }
    },
  } as any;
}

describe('FileResourceService', () => {
  let tempDir: string;
  let previousCwd: string;

  beforeEach(async () => {
    previousCwd = process.cwd();
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'srvpro2-file-resource-test-'),
    );
    process.chdir(tempDir);
    await fs.mkdir(path.join(tempDir, 'resource'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'resource', 'default_data.json'),
      JSON.stringify(
        {
          dialogues: EMPTY_DIALOGUES_DATA,
        },
        null,
        2,
      ),
      'utf-8',
    );
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('fills missing dialogues_custom and saves the repaired file', async () => {
    const dataPath = path.join(tempDir, 'data', 'dialogues.json');
    await fs.writeFile(
      dataPath,
      JSON.stringify(
        {
          file: './data/dialogues.json',
          dialogues: {
            '123': ['test'],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const service = new FileResourceService(makeCtx());
    await service.ensureInitialized();

    const data = service.getDataOrEmpty('dialogues', EMPTY_DIALOGUES_DATA);
    expect(data.dialogues).toEqual({
      '123': ['test'],
    });
    expect(data.dialogues_custom).toEqual({});

    const savedData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
    expect(savedData.dialogues_custom).toEqual({});
  });

  test('fills missing dialogues and saves the repaired file', async () => {
    const dataPath = path.join(tempDir, 'data', 'dialogues.json');
    await fs.writeFile(
      dataPath,
      JSON.stringify(
        {
          file: './data/dialogues.json',
          dialogues_custom: {
            '456': ['custom'],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const service = new FileResourceService(makeCtx());
    await service.ensureInitialized();

    const data = service.getDataOrEmpty('dialogues', EMPTY_DIALOGUES_DATA);
    expect(data.dialogues).toEqual({});
    expect(data.dialogues_custom).toEqual({
      '456': ['custom'],
    });

    const savedData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
    expect(savedData.dialogues).toEqual({});
  });
});
