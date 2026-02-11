import { BasePlugin, type PluginMeta } from "./base.js";

export class HttpPlugin extends BasePlugin {
  readonly meta: PluginMeta = {
    name: "http",
    version: "1.0.0",
  };

  private server: unknown = null;

  async start(): Promise<void> {
    this.server = { listening: true };
  }

  async stop(): Promise<void> {
    this.server = null;
  }
}
