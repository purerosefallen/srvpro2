import {
  buildRoomlistMenuTitle,
  formatRoomlistStatusPrefix,
  ROOMLIST_MENU_TITLE_MAX_LENGTH,
  RoomlistMenuTitleInfo,
} from '../src/join-handlers/roomlist-menu-title';
import { DuelStage } from '../src/room';

function createRoomTitleInfo(
  info: Partial<RoomlistMenuTitleInfo>,
): RoomlistMenuTitleInfo {
  return {
    name: 'room-name',
    duelStage: DuelStage.Begin,
    duelCount: 0,
    turnCount: 0,
    ...info,
  };
}

describe('roomlist menu title', () => {
  it('formats legacy room statuses as compact menu prefixes', () => {
    expect(formatRoomlistStatusPrefix(createRoomTitleInfo({}))).toBe('W');
    expect(
      formatRoomlistStatusPrefix(
        createRoomTitleInfo({
          duelStage: DuelStage.Dueling,
          duelCount: 1,
          turnCount: 1,
        }),
      ),
    ).toBe('G1T1');
    expect(
      formatRoomlistStatusPrefix(
        createRoomTitleInfo({
          duelStage: DuelStage.Siding,
          duelCount: 1,
        }),
      ),
    ).toBe('G1S');
    expect(
      formatRoomlistStatusPrefix(
        createRoomTitleInfo({ duelStage: DuelStage.Finger }),
      ),
    ).toBe('G0R');
    expect(
      formatRoomlistStatusPrefix(
        createRoomTitleInfo({ duelStage: DuelStage.FirstGo }),
      ),
    ).toBe('G0F');
  });

  it('prefixes room names and leaves room for the null terminator', () => {
    expect(
      buildRoomlistMenuTitle(
        createRoomTitleInfo({
          duelStage: DuelStage.Dueling,
          duelCount: 1,
          name: 'A very very long room name',
          turnCount: 12,
        }),
      ),
    ).toBe('G1T12|A very very..');
    expect(
      buildRoomlistMenuTitle(createRoomTitleInfo({ name: 'short room' })),
    ).toBe('W|short room');
    expect(
      buildRoomlistMenuTitle(
        createRoomTitleInfo({ name: 'A very very long room name' }),
      ).length,
    ).toBe(ROOMLIST_MENU_TITLE_MAX_LENGTH);
  });
});
