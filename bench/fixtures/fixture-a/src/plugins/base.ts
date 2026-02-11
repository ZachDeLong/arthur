export interface PluginMeta {
  name: string;
  version: string;
  dependencies?: string[];
}

export abstract class BasePlugin {
  abstract readonly meta: PluginMeta;

  async init(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
