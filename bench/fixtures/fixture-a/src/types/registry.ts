import type { BasePlugin } from "../plugins/base.js";

export interface RegistryEntry {
  plugin: BasePlugin;
  status: "registered" | "initialized" | "running" | "stopped";
}

export type PluginMap = Map<string, RegistryEntry>;

export interface RegistryOptions {
  configPath: string;
  strict?: boolean;
}
