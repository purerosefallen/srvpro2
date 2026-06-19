import { ReplayRecordCodecDriver, ReplayRecordSchemaVersion } from './types';
import { replayRecordCodecDriverV0 } from './v0';
import { replayRecordCodecDriverV1 } from './v1';

export const CURRENT_REPLAY_RECORD_SCHEMA_VERSION: ReplayRecordSchemaVersion = 1;

const replayRecordCodecDrivers = new Map<number, ReplayRecordCodecDriver>([
  [replayRecordCodecDriverV0.schemaVersion, replayRecordCodecDriverV0],
  [replayRecordCodecDriverV1.schemaVersion, replayRecordCodecDriverV1],
]);

export function getReplayRecordCodecDriver(
  schemaVersion: number | null | undefined,
) {
  const normalizedSchemaVersion = schemaVersion ?? 0;
  const driver = replayRecordCodecDrivers.get(normalizedSchemaVersion);
  if (!driver) {
    throw new Error(
      `Unsupported replay record schema version: ${normalizedSchemaVersion}`,
    );
  }
  return driver;
}

export function getCurrentReplayRecordCodecDriver() {
  return getReplayRecordCodecDriver(CURRENT_REPLAY_RECORD_SCHEMA_VERSION);
}
