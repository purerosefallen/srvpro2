import { AppContext } from 'nfkit';
import { DataSource } from 'typeorm';
import { ConfigService } from './config';
import { Logger } from './logger';
import { RandomDuelScore } from '../feats/random-duel';
import { DuelRecordEntity, DuelRecordPlayer } from '../feats/cloud-replay';
import { LegacyApiRecordEntity } from '../legacy-api/legacy-api-record.entity';
import { LegacyBanEntity } from '../legacy-api/legacy-ban.entity';
import { LegacyDeckEntity } from '../legacy-api/legacy-deck.entity';
import { collectPluginTypeormEntities } from './plugin-typeorm-entity-loader';

export class TypeormLoader {
  constructor(private ctx: AppContext) {}

  database: DataSource | undefined;

  setDatabase(database: DataSource | undefined) {
    this.database = database;
    return this;
  }
}

export const TypeormFactory = async (ctx: AppContext) => {
  const loader = new TypeormLoader(ctx);
  const config = ctx.get(ConfigService).config;
  const logger = ctx.get(Logger).createLogger('TypeormLoader');

  const host = config.getString('DB_HOST');
  if (!host) {
    logger.info('database disabled because DB_HOST is empty');
    return loader.setDatabase(undefined);
  }

  const port = config.getInt('DB_PORT') || 5432;
  const username = config.getString('DB_USER');
  const password = config.getString('DB_PASS');
  const database = config.getString('DB_NAME');
  const synchronize = !config.getBoolean('DB_NO_INIT');
  const staticEntities: Function[] = [
    RandomDuelScore,
    DuelRecordEntity,
    DuelRecordPlayer,
    LegacyApiRecordEntity,
    LegacyBanEntity,
    LegacyDeckEntity,
  ];
  const pluginEntities = collectPluginTypeormEntities(logger);
  const entities = [...new Set<Function>([...staticEntities, ...pluginEntities])];

  if (pluginEntities.length > 0) {
    logger.info(
      {
        count: pluginEntities.length,
        entities: pluginEntities.map((entity) => entity.name),
      },
      'Collected plugin typeorm entities',
    );
  }

  const dataSource = new DataSource({
    type: 'postgres',
    host,
    port,
    username,
    password,
    database,
    synchronize,
    entities,
  });

  try {
    await dataSource.initialize();
    logger.info(
      {
        host,
        port,
        database,
        synchronize,
      },
      'Database initialized',
    );
    return loader.setDatabase(dataSource);
  } catch (error) {
    logger.error(
      {
        host,
        port,
        database,
        err: error,
      },
      'Database initialization failed',
    );
    throw error;
  }
};
