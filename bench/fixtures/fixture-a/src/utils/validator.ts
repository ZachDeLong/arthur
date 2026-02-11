import type { PluginMeta } from "../plugins/base.js";

export function validateMeta(meta: PluginMeta): string[] {
  const errors: string[] = [];
  if (!meta.name || meta.name.length === 0) {
    errors.push("Plugin name is required");
  }
  if (!/^\d+\.\d+\.\d+$/.test(meta.version)) {
    errors.push("Version must be semver format (x.y.z)");
  }
  return errors;
}
