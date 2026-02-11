export type PluginEvent =
  | "plugin:registered"
  | "plugin:initialized"
  | "plugin:started"
  | "plugin:stopped"
  | "plugin:error";

export interface PluginEventPayload {
  pluginName: string;
  event: PluginEvent;
  timestamp: number;
  error?: Error;
}
