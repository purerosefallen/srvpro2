import * as P from 'ygopro-msg-encode';
import { DuelRecord } from '../src/room';
import { RewindService } from '../src/feats/windbot/rewind-service';
import { replayAngelus } from '../src/utility/replay-angelus';

function fixture() {
  const choice = () =>
    new P.YGOProMsgSelectYesNo().fromPartial({ player: 0, desc: 42 });
  const turn = new P.YGOProMsgNewTurn().fromPartial({ player: 0 });
  const phase = new P.YGOProMsgNewPhase().fromPartial({ phase: 4 });
  const record = new DuelRecord([1, 2, 3, 4, 5, 6, 7, 8], [], false);
  const choices = [choice(), choice(), choice()];
  record.messages.push(new P.YGOProMsgStart(), turn, phase, ...choices);
  record.responses = [Buffer.from([1]), Buffer.from([0])];
  const batches = [[turn, phase, choices[0]], [choices[1]], [choices[2]]];
  const candidate = {
    active: true,
    close: jest.fn(),
    setResponse: jest.fn(),
    advance: jest.fn(async function* () {
      for (const message of batches.shift()!)
        yield { message, raw: message.toPayload() };
    }),
  };
  const original = { active: true, close: jest.fn() };
  const player = { pos: 0 };
  const room: any = {
    angelus: original,
    identifier: 'test-match',
    lastDuelRecord: record,
    responsePos: 0,
    responsePlayer: player,
    lastResponseRequestMsg: choices[2],
    turnCount: 1,
    watchers: [],
    playingPlayers: [player],
    getIngameDuelPos: () => 0,
    getIngameOperatingPlayer: () => player,
    openCandidate: jest.fn(async () => candidate),
    attachAngelus(client) {
      this.angelus = client;
    },
    restoreChoice(msg) {
      this.lastResponseRequestMsg = msg;
    },
    setResponseTimer: jest.fn(),
    timerState: {
      runningPos: 0,
      awaitingConfirm: true,
      leftMs: [1500, 1800],
      clear: jest.fn(),
    },
    finalize: jest.fn(),
    win: jest.fn(),
  };
  const service = new RewindService({
    get: () => ({}),
    createLogger: () => ({ warn: jest.fn() }),
  } as any);
  jest.spyOn(service as any, 'rewindSendToPlayer').mockResolvedValue(undefined);
  return {
    original,
    candidate,
    record,
    choices,
    player,
    room,
    service,
    batches,
  };
}
test.each([0, 1])(
  'verifies and stops before response %i without mutating the record',
  async (target) => {
    const { candidate, record, choices } = fixture();
    const state = await replayAngelus(candidate as any, record, target);
    expect(state.choice).toBe(choices[target]);
    expect(state.turnCount).toBe(1);
    expect(state.phase).toBe(4);
    expect(candidate.setResponse).toHaveBeenCalledTimes(target);
    expect(record.responses).toHaveLength(2);
  },
);
test('successful undo swaps and truncates once, then can undo the preceding choice', async () => {
  const { candidate, original, room, record, choices, service, player } =
    fixture();
  expect(await service.rewind(room, player as any)).toBe(
    '#{koishi_rewind_success}',
  );
  expect(room.angelus).toBe(candidate);
  expect(record.messages.at(-1)).toBe(choices[1]);
  expect(record.responses).toEqual([Buffer.from([1])]);
  expect(room.lastResponseRequestMsg).toBe(choices[1]);
  expect(original.close).toHaveBeenCalledTimes(1);
  const second = fixture().candidate;
  room.openCandidate.mockResolvedValue(second);
  expect(await service.rewind(room, player as any)).toBe(
    '#{koishi_rewind_success}',
  );
  expect(record.messages.at(-1)).toBe(choices[0]);
  expect(record.responses).toHaveLength(0);
});
test.each([
  'connect',
  'timeout',
  'bytes',
  'retry',
  'closed candidate',
  'lost primary',
])('undo handles %s without modifying old history', async (fault) => {
  const {
    service,
    candidate,
    original,
    record,
    choices,
    room,
    player,
    batches,
  } = fixture();
  if (fault === 'connect')
    room.openCandidate.mockRejectedValue(new Error('connect'));
  if (fault === 'timeout')
    candidate.setResponse.mockRejectedValue(new Error('timeout'));
  if (fault === 'bytes') record.messageBytes.set(choices[0], Uint8Array.of(99));
  if (fault === 'retry') batches[0].push(new P.YGOProMsgRetry() as any);
  if (fault === 'closed candidate') candidate.active = false;
  if (fault === 'lost primary') original.active = false;
  await service.rewind(room, player as any);
  expect(room.angelus).toBe(original);
  expect(record.responses).toHaveLength(2);
  expect(record.messages.at(-1)).toBe(choices[2]);
  expect(room.turnCount).toBe(1);
  expect(room.lastResponseRequestMsg).toBe(choices[2]);
  expect(room.timerState.leftMs).toEqual([1500, 1800]);
  expect(room.win).not.toHaveBeenCalled();
  expect(room.finalize).not.toHaveBeenCalled();
  expect(room.setResponseTimer).toHaveBeenCalledTimes(
    fault === 'lost primary' ? 0 : 1,
  );
  expect(candidate.close).toHaveBeenCalledTimes(fault === 'connect' ? 0 : 1);
  expect(original.close).not.toHaveBeenCalled();
});
test('a second Undo does not open a connection while verification is pending', async () => {
  const { service, candidate, room, player } = fixture();
  let open;
  room.openCandidate.mockReturnValue(
    new Promise((resolve) => {
      open = resolve;
    }),
  );
  const first = service.rewind(room, player as any);
  await service.rewind(room, player as any);
  expect(room.openCandidate).toHaveBeenCalledTimes(1);
  open(candidate);
  await first;
});
