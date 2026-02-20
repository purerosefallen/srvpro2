import { Fragment as KoishiFragment, h } from 'koishi';
import { ChatColor } from 'ygopro-msg-encode';
import { ValueContainer } from './value-container';
import type { Client } from '../client';

export type KoishiElement = h;
export { KoishiFragment };

export type ChatToken = {
  text: string;
  color?: number;
};

export type ColoredChatMessage = {
  text: string;
  color: number;
};

export type PlayerNameClient = Pick<Client, 'pos' | 'name' | 'roomName'>;

export class OnSendChatElement extends ValueContainer<
  KoishiElement | undefined
> {
  constructor(
    public sightPlayer: Client,
    public type: number,
    element: KoishiElement,
  ) {
    super(element);
  }
}

export function PlayerName(
  client: PlayerNameClient,
  content: KoishiFragment = client.name || '',
) {
  return h('PlayerName', { client }, content);
}

export function normalizeChatColor(value: number) {
  if (typeof (ChatColor as any)[value] === 'string') {
    return value;
  }
  return ChatColor.BABYBLUE;
}

export function resolveElementChatColor(
  element: KoishiElement,
): number | undefined {
  const isChatElement =
    typeof element.type === 'string' && element.type.toLowerCase() === 'chat';
  const rawColor = isChatElement
    ? element.attrs?.color
    : element.attrs?.chatColor;
  if (rawColor == null) {
    return undefined;
  }
  if (typeof rawColor === 'number') {
    return normalizeChatColor(rawColor);
  }
  if (typeof rawColor !== 'string') {
    return undefined;
  }
  const normalized = rawColor.replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (!normalized) {
    return undefined;
  }
  const enumValue = (ChatColor as any)[normalized];
  if (typeof enumValue === 'number') {
    return enumValue;
  }
  const parsed = Number(rawColor);
  if (Number.isFinite(parsed)) {
    return normalizeChatColor(parsed);
  }
  return undefined;
}

export async function collectKoishiTextTokens(
  elements: KoishiElement[],
  resolveElement?: (
    element: KoishiElement,
  ) => Promise<KoishiElement | undefined>,
  inheritedColor?: number,
): Promise<ChatToken[]> {
  const tokens: ChatToken[] = [];
  for (const rawElement of elements) {
    if (!rawElement) {
      continue;
    }
    const element = resolveElement
      ? await resolveElement(rawElement)
      : rawElement;
    if (!element) {
      continue;
    }

    const color = resolveElementChatColor(element) ?? inheritedColor;
    if (element.type === 'text') {
      const content = element.attrs?.content;
      if (typeof content === 'string' && content.length > 0) {
        tokens.push({
          text: content,
          color,
        });
      }
    } else if (element.type === 'br') {
      tokens.push({
        text: '\n',
        color,
      });
    }

    if (element.children?.length) {
      tokens.push(
        ...(await collectKoishiTextTokens(
          element.children as KoishiElement[],
          resolveElement,
          color,
        )),
      );
    }
  }
  return tokens;
}

export function resolveColoredMessages(
  tokens: ChatToken[],
  defaultColor = ChatColor.BABYBLUE,
): ColoredChatMessage[] {
  const cleanedTokens = tokens.filter((token) => token.text.length > 0);
  if (!cleanedTokens.length) {
    return [];
  }
  let currentColor = normalizeChatColor(defaultColor);
  let currentText = '';
  const result: ColoredChatMessage[] = [];

  for (const token of cleanedTokens) {
    const tokenColor =
      typeof token.color === 'number'
        ? normalizeChatColor(token.color)
        : currentColor;
    if (tokenColor !== currentColor && currentText) {
      result.push({
        text: currentText,
        color: currentColor,
      });
      currentText = '';
    }
    currentColor = tokenColor;
    currentText += token.text;
  }

  if (currentText) {
    result.push({
      text: currentText,
      color: currentColor,
    });
  }

  return result;
}

export function splitColoredMessagesByLine(messages: ColoredChatMessage[]) {
  const result: ColoredChatMessage[] = [];
  let previousEndedWithNewline = false;
  for (const message of messages) {
    const lines = message.text.split(/\r?\n/);
    const endedWithNewline = /\r?\n$/.test(message.text);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const isFirst = i === 0;
      const isLast = i === lines.length - 1;
      if (isLast && line.length === 0 && endedWithNewline) {
        continue;
      }
      if (
        isFirst &&
        line.length === 0 &&
        !previousEndedWithNewline &&
        result.length > 0
      ) {
        continue;
      }
      result.push({
        text: line,
        color: message.color,
      });
    }
    previousEndedWithNewline = endedWithNewline;
  }
  return result;
}
