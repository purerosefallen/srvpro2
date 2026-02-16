export interface WindbotData {
  name: string;
  deck: string;
  dialog?: string;
  hidden?: boolean;
  deckcode?: string;
}

export interface RequestWindbotJoinOptions {
  hand?: 1 | 2 | 3;
}

export interface WindbotJoinTokenData {
  roomName: string;
  windbot: WindbotData;
}
