import {
  ChatColor,
  OcgcoreCommonConstants,
  OcgcoreScriptConstants,
  YGOProMsgBase,
  YGOProMsgChaining,
  YGOProMsgPosChange,
  YGOProMsgSpSummoning,
  YGOProMsgSummoning,
  YGOProMsgUpdateCard,
  YGOProMsgWaiting,
} from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { Room, RoomManager } from '../../room';
import { ValueContainer } from '../../utility/value-container';
import { pickRandom } from '../../utility/pick-random';
import { BaseResourceProvider } from './base-resource-provider';
import { DialoguesData, EMPTY_DIALOGUES_DATA } from './types';

export class DialoguesLookup extends ValueContainer<string[]> {
  constructor(
    public room: Room,
    public client: Client,
    public cardCode: number,
  ) {
    super([]);
  }
}

export class DialoguesProvider extends BaseResourceProvider<DialoguesData> {
  enabled = this.ctx.config.getBoolean('ENABLE_DIALOGUES');

  private roomManager = this.ctx.get(() => RoomManager);

  constructor(ctx: Context) {
    super(ctx, {
      resourceName: 'dialogues',
      emptyData: EMPTY_DIALOGUES_DATA,
    });

    if (!this.enabled) {
      return;
    }

    this.ctx.middleware(YGOProMsgBase, async (msg, client, next) => {
      await this.handleDialogueMessage(msg, client);
      return next();
    });
  }

  async refreshResources() {
    if (!this.enabled) {
      return false;
    }
    return this.refreshFromRemote();
  }

  async getRandomDialogue(room: Room, client: Client, cardCode: number) {
    if (!this.enabled) {
      return undefined;
    }
    const event = await this.ctx.dispatch(
      new DialoguesLookup(room, client, cardCode),
      client,
    );
    const dialogues = (event?.value || []).filter((line) => !!line);
    return pickRandom(dialogues);
  }

  protected registerLookupMiddleware() {
    this.ctx.middleware(DialoguesLookup, async (event, _client, next) => {
      const data = this.getResourceData();
      const key = event.cardCode.toString();
      event.use(data.dialogues[key] || data.dialogues_custom[key] || []);
      return next();
    });
  }

  protected getRemoteLoadEntries() {
    return [
      {
        field: 'dialogues' as const,
        url: this.ctx.config.getString('DIALOGUES_GET').trim(),
      },
      {
        field: 'dialogues_custom' as const,
        url: this.ctx.config.getString('DIALOGUES_GET_CUSTOM').trim(),
      },
    ];
  }

  private async sendDialogueByCardCode(client: Client, cardCode: number) {
    if (!client.roomName) {
      return;
    }
    const room = this.roomManager.findByName(client.roomName);
    if (!room) {
      return;
    }
    const dialogue = await this.getRandomDialogue(room, client, cardCode);
    if (!dialogue) {
      return;
    }
    await room.sendChat(dialogue, ChatColor.PINK);
  }

  private async handleDialogueMessage(message: YGOProMsgBase, client: Client) {
    if (message instanceof YGOProMsgSummoning) {
      await this.sendDialogueByCardCode(client, message.code);
    } else if (message instanceof YGOProMsgSpSummoning) {
      await this.sendDialogueByCardCode(client, message.code);
    } else if (message instanceof YGOProMsgChaining) {
      if (this.canTriggerChainingDialogue(message, client)) {
        await this.sendDialogueByCardCode(client, message.code);
      }
    }

    this.updateReadyTrapState(client, message);
  }

  private canTriggerChainingDialogue(
    message: YGOProMsgChaining,
    client: Client,
  ) {
    const fromSpellTrapZone =
      (message.location & OcgcoreScriptConstants.LOCATION_SZONE) !== 0;
    return fromSpellTrapZone && !!client.readyTrap;
  }

  private updateReadyTrapState(client: Client, message: YGOProMsgBase) {
    if (message instanceof YGOProMsgPosChange) {
      const isSpellTrapZone =
        (message.card.location & OcgcoreScriptConstants.LOCATION_SZONE) !== 0;
      const fromFacedown =
        (message.previousPosition & OcgcoreCommonConstants.POS_FACEDOWN) !== 0;
      const toFaceup =
        (message.currentPosition & OcgcoreCommonConstants.POS_FACEUP) !== 0;
      client.readyTrap = isSpellTrapZone && fromFacedown && toFaceup;
      return;
    }

    if (
      !(message instanceof YGOProMsgUpdateCard) &&
      !(message instanceof YGOProMsgWaiting)
    ) {
      client.readyTrap = false;
    }
  }

  protected isEnabled() {
    return this.enabled;
  }
}

declare module '../../client' {
  interface Client {
    readyTrap?: boolean;
  }
}
