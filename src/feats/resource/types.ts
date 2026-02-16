export interface TipsData {
  file: string;
  tips: string[];
  tips_zh: string[];
}

export interface WordsData {
  file: string;
  words: Record<string, string[]>;
}

export interface DialoguesData {
  file: string;
  dialogues: Record<string, string[]>;
  dialogues_custom: Record<string, string[]>;
}

export interface BadwordsData {
  file: string;
  level0: string[];
  level1: string[];
  level2: string[];
  level3: string[];
}

export const EMPTY_TIPS_DATA: TipsData = {
  file: './data/tips.json',
  tips: [],
  tips_zh: [],
};

export const EMPTY_WORDS_DATA: WordsData = {
  file: './data/words.json',
  words: {},
};

export const EMPTY_DIALOGUES_DATA: DialoguesData = {
  file: './data/dialogues.json',
  dialogues: {},
  dialogues_custom: {},
};

export const EMPTY_BADWORDS_DATA: BadwordsData = {
  file: './data/badwords.json',
  level0: [],
  level1: [],
  level2: [],
  level3: [],
};
