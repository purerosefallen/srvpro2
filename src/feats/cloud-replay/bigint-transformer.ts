import { ValueTransformer } from 'typeorm';

export class BigintTransformer implements ValueTransformer {
  from(dbValue: unknown) {
    if (dbValue == null) {
      return dbValue;
    }
    return Number.parseInt(String(dbValue), 10);
  }

  to(entityValue: unknown) {
    return entityValue;
  }
}
