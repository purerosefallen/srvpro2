import { Context } from '../../app';
import { ValueContainer } from '../../utility/value-container';
import { FileResourceService } from './file-resource-service';
import { cloneJson } from './resource-util';

type AnyObject = Record<string, unknown>;

type RemoteEntry<T extends object> = {
  field: keyof T & string;
  url: string;
};

export abstract class BaseResourceProvider<T extends object> {
  protected logger = this.ctx.createLogger(this.constructor.name);
  protected fileResourceService = this.ctx.get(() => FileResourceService);

  protected data: ValueContainer<T>;
  public resource: ValueContainer<T>;

  constructor(
    protected ctx: Context,
    private options: {
      resourceName: string;
      emptyData: T;
    },
  ) {
    this.data = new ValueContainer(cloneJson(this.options.emptyData));
    this.resource = this.data;
  }

  async init() {
    await this.fileResourceService.ensureInitialized();
    this.loadLocalData();
    this.registerLookupMiddleware();
    if (!this.isEnabled()) {
      return;
    }
    await this.refreshFromRemote();
  }

  async refreshFromRemote() {
    if (!this.isEnabled()) {
      return false;
    }
    const entries = this.getRemoteLoadEntries().filter((entry) => !!entry.url);
    if (!entries.length) {
      return false;
    }

    const nextData = cloneJson(this.data.value);

    for (const entry of entries) {
      const fetched = await this.fetchRemoteData(entry.url);
      if (fetched == null) {
        return false;
      }
      (nextData as Record<string, unknown>)[entry.field] = fetched;
      this.logger.info(
        {
          resource: this.options.resourceName,
          field: entry.field,
          url: entry.url,
        },
        'Loaded remote resource',
      );
    }

    await this.updateData(nextData);
    return true;
  }

  protected getResourceData() {
    return this.data.value;
  }

  protected abstract registerLookupMiddleware(): void;

  protected getRemoteLoadEntries(): RemoteEntry<T>[] {
    return [];
  }

  protected onDataUpdated(_nextData: T): void {}

  protected isEnabled() {
    return true;
  }

  private loadLocalData() {
    const localData = this.fileResourceService.getDataOrEmpty(
      this.options.resourceName,
      this.options.emptyData,
    );
    this.data.use(localData);
    this.onDataUpdated(localData);
    this.logger.info(
      { resource: this.options.resourceName },
      'Loaded local resource',
    );
  }

  protected async updateData(nextData: T) {
    this.data.use(cloneJson(nextData));
    this.onDataUpdated(this.data.value);
    await this.fileResourceService.saveData(
      this.options.resourceName,
      nextData as AnyObject,
    );
  }

  private async fetchRemoteData(url: string) {
    try {
      const body = (
        await this.ctx.http.get(url, {
          responseType: 'json',
        })
      ).data;
      if (!body || typeof body === 'string') {
        this.logger.warn(
          {
            resource: this.options.resourceName,
            url,
          },
          'Remote resource response is invalid',
        );
        return undefined;
      }
      return body as unknown;
    } catch (error) {
      this.logger.warn(
        {
          resource: this.options.resourceName,
          url,
          error: (error as Error).toString(),
        },
        'Failed loading remote resource',
      );
      return undefined;
    }
  }
}
