import { Context } from '../app';
import { Metadata } from './metadata';

export const DefinePlugin =
  (name?: string): ClassDecorator =>
  (cls) =>
    Metadata.set('plugin', name ?? cls.name)(cls);

export class BasePlugin {
  constructor(protected ctx: Context) {}
}
