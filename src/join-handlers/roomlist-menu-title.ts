import { DuelStage } from '../room';

export const ROOMLIST_MENU_TITLE_FIELD_LENGTH = 20;
export const ROOMLIST_MENU_TITLE_MAX_LENGTH =
  ROOMLIST_MENU_TITLE_FIELD_LENGTH - 1;

export type RoomlistMenuTitleInfo = {
  duelCount: number;
  duelStage: DuelStage;
  name: string;
  turnCount: number;
};

export function buildRoomlistMenuTitle(info: RoomlistMenuTitleInfo) {
  return truncateRoomlistMenuTitle(
    `${formatRoomlistStatusPrefix(info)}|${info.name}`,
  );
}

export function formatRoomlistStatusPrefix(
  info: Pick<RoomlistMenuTitleInfo, 'duelCount' | 'duelStage' | 'turnCount'>,
) {
  if (info.duelStage === DuelStage.Begin) {
    return 'W';
  }

  const duelText = `G${info.duelCount}`;
  if (info.duelStage === DuelStage.Siding) {
    return `${duelText}S`;
  }
  if (info.duelStage === DuelStage.Finger) {
    return `${duelText}R`;
  }
  if (info.duelStage === DuelStage.FirstGo) {
    return `${duelText}F`;
  }
  if (info.duelStage === DuelStage.Dueling) {
    const turn = Number.isFinite(info.turnCount) ? Number(info.turnCount) : 0;
    return `${duelText}T${turn}`;
  }

  return 'S';
}

export function truncateRoomlistMenuTitle(title: string) {
  if (title.length <= ROOMLIST_MENU_TITLE_MAX_LENGTH) {
    return title;
  }
  return `${title.slice(0, ROOMLIST_MENU_TITLE_MAX_LENGTH - 2)}..`;
}
