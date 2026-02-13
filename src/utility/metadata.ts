import { MetadataSetter, Reflector } from 'typed-reflector';

interface MetadataMap {
  roomMethod: boolean;
}

type MetadataArrayMap = {
  [K in keyof MetadataMap as `${K & string}Keys`]: string;
};

export const Metadata = new MetadataSetter<MetadataMap, MetadataArrayMap>();
export const reflector = new Reflector<MetadataMap, MetadataArrayMap>();

export function getSpecificFields<K extends keyof MetadataMap>(
  key: K,
  target: any,
): { key: string; metadata: MetadataMap[K] }[] {
  const arrayKey = `${key}Keys` as keyof MetadataArrayMap;
  const keys = reflector.getArray(arrayKey, target);
  return keys
    .map((k) => ({
      key: k,
      metadata: reflector.get(key, target, k),
    }))
    .filter((item) => item.metadata !== undefined) as {
    key: string;
    metadata: MetadataMap[K];
  }[];
}
