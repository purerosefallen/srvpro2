import { AngelusClient } from '../angelus';
import { DuelRecord } from '../room';
import {
  YGOProMsgBase,
  YGOProMsgHint,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgResponseBase,
  YGOProMsgRetry,
} from 'ygopro-msg-encode';
import { isUpdateMessage } from './is-update-message';

const skip = (msg: YGOProMsgBase) =>
  isUpdateMessage(msg) || msg instanceof YGOProMsgHint;

/** Verify a candidate without modifying the active room or the recorded inputs. */
export async function replayAngelus(
  duel: AngelusClient,
  record: DuelRecord,
  target: number,
) {
  let pointer = 1; // The game server synthesizes MSG_START.
  let response = 0;
  let turnCount = 0;
  let turnPlayer = 0;
  let phase: number | undefined;
  for (;;) {
    let choice: YGOProMsgResponseBase | undefined;
    for await (const { message, raw } of duel.advance()) {
      if (message instanceof YGOProMsgRetry)
        throw new Error('Unexpected retry during Undo');
      if (skip(message)) continue;
      while (record.messages[pointer] && skip(record.messages[pointer]))
        ++pointer;
      const expected = record.messages[pointer++];
      if (
        !expected ||
        !Buffer.from(raw).equals(
          Buffer.from(
            record.messageBytes.get(expected) ?? expected.toPayload(),
          ),
        )
      )
        throw new Error('Undo message mismatch at ' + (pointer - 1));
      if (message instanceof YGOProMsgNewTurn && !(message.player & 2)) {
        ++turnCount;
        turnPlayer = message.player & 1;
      }
      if (message instanceof YGOProMsgNewPhase) phase = message.phase;
      if (expected instanceof YGOProMsgResponseBase) choice = expected;
    }
    if (!choice) throw new Error('Undo ended before the target choice');
    if (response === target)
      return { pointer, choice, phase, turnCount, turnPlayer };
    const input = record.responses[response++];
    if (!input) throw new Error('Missing Undo response');
    await duel.setResponse(input);
  }
}
