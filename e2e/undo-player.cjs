// A human protocol client in an AI room. Set a card, undo, then take a different action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const P = require('ygopro-msg-encode');
const Deck = require('ygopro-deck-encode').default;
const { PacketReader } = require('./packet-reader.cjs');

const deck = Deck.fromYdkString(fs.readFileSync('/fixture.ydk', 'utf8'));
const player = net.connect(7911, 'srvpro2');
let originalChoice;
let requested = false;
let confirmed = false;
let continued = false;
let nextTurn = false;
let surrendered = false;
let finished = false;

function send(packet) {
  player.write(packet.toFullPayload());
}
function respond(response) {
  assert.ok(response, 'Expected a legal response');
  send(new P.YGOProCtosResponse().fromPartial({ response }));
}
function handleGame(message) {
  if (message instanceof P.YGOProMsgWin) {
    if (surrendered) {
      assert.equal(message.type, 0);
      assert.notEqual(message.player, 2);
      finished = true;
    }
    return;
  }
  if (continued && message instanceof P.YGOProMsgNewTurn) nextTurn = true;
  if (message instanceof P.YGOProMsgSelectIdleCmd) {
    if (!originalChoice) {
      originalChoice = Buffer.from(message.toPayload());
      if (message.msetableCards.length)
        return respond(
          message.prepareResponse(P.IdleCmdType.MSET, { index: 0 }),
        );
      assert.ok(message.ssetableCards.length);
      return respond(message.prepareResponse(P.IdleCmdType.SSET, { index: 0 }));
    }
    if (!requested) {
      requested = true;
      return send(new P.YGOProCtosChat().fromPartial({ msg: '/undo' }));
    }
    assert.deepEqual(
      Buffer.from(message.toPayload()),
      originalChoice,
      'Restored choice differs from the original',
    );
    continued = true;
    return respond(message.prepareResponse(P.IdleCmdType.TO_EP));
  }
  if (message instanceof P.YGOProMsgRetry)
    throw new Error('The continued input was rejected');
  if (message instanceof P.YGOProMsgSelectPlace)
    return respond(
      message.prepareResponse(message.getSelectablePlaces().slice(0, 1)),
    );
  if (message instanceof P.YGOProMsgSelectPosition)
    return respond(
      message.prepareResponse(message.positions & -message.positions),
    );
  if (message instanceof P.YGOProMsgResponseBase)
    return respond(message.defaultResponse());
}

const frames = new PacketReader((packet) => {
  const id = packet[2];
  if (id === P.YGOProStocJoinGame.identifier)
    send(new P.YGOProCtosUpdateDeck().fromPartial({ deck }));
  if (id === P.YGOProStocSelectHand.identifier)
    send(new P.YGOProCtosHandResult().fromPartial({ res: P.HandResult.ROCK }));
  if (id === P.YGOProStocSelectTp.identifier)
    send(
      new P.YGOProCtosTpResult().fromPartial({ res: P.TurnPlayerResult.FIRST }),
    );
  if (id === P.YGOProStocErrorMsg.identifier)
    throw new Error('Game server rejected the test player');
  if (id === P.YGOProStocChat.identifier) {
    const { msg } = new P.YGOProStocChat().fromFullPayload(packet);
    if (/悔棋成功|Rewind succeeded/i.test(msg)) confirmed = true;
    if (/悔棋失败|Rewind failed/i.test(msg)) throw new Error(msg);
  }
  if (id === P.YGOProStocGameMsg.identifier)
    handleGame(new P.YGOProStocGameMsg().fromFullPayload(packet).msg);
  if (confirmed && nextTurn && !surrendered) {
    surrendered = true;
    send(new P.YGOProCtosSurrender());
  }
});
player.once('connect', () => {
  send(new P.YGOProCtosPlayerInfo().fromPartial({ name: 'UndoPlayer' }));
  send(
    new P.YGOProCtosJoinGame().fromPartial({
      version: 0x1362,
      pass: 'AI,ROCK#Burn',
    }),
  );
});
player.on('data', (data) => frames.receive(data));
player.on('close', () => {
  assert.ok(
    requested && confirmed && continued && nextTurn && finished,
    'Incomplete Undo duel',
  );
  console.log(
    'Verified original choice, successful Undo, alternate action, next turn and surrender',
  );
});
