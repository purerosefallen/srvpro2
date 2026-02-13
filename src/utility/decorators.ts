import { Metadata } from './metadata';
import { DuelStage } from '../room/duel-stage';
import { MayBeArray } from 'nfkit';

export interface RoomMethodOptions {
  allowInDuelStages?: MayBeArray<DuelStage>;
}

export const RoomMethod = (options: RoomMethodOptions = {}): MethodDecorator =>
  Metadata.set('roomMethod', options, 'roomMethodKeys');
