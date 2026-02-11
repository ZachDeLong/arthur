import { BasePlugin, type PluginMeta } from "./base.js";

export class LoggerPlugin extends BasePlugin {
  readonly meta: PluginMeta = {
    name: "logger",
    version: "1.0.0",
  };

  log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}
