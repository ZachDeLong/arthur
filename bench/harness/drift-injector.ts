import type { DriftSpec } from "./types.js";

export interface InjectionResult {
  modifiedPlan: string;
  applied: boolean;
}

/** Inject drift into a plan according to a drift spec. Pure function, no API calls. */
export function injectDrift(plan: string, spec: DriftSpec): InjectionResult {
  const { method } = spec.injection;

  switch (method) {
    case "append":
      return applyAppend(plan, spec);
    case "replace":
    case "remove-and-replace":
      return applyReplace(plan, spec);
    default:
      return { modifiedPlan: plan, applied: false };
  }
}

function applyAppend(plan: string, spec: DriftSpec): InjectionResult {
  const text = spec.injection.appendText;
  if (!text) return { modifiedPlan: plan, applied: false };

  const modifiedPlan =
    plan.trimEnd() +
    "\n\n## Additional Considerations\n\n" +
    text +
    "\n";

  return { modifiedPlan, applied: true };
}

function applyReplace(plan: string, spec: DriftSpec): InjectionResult {
  const { searchPattern, replaceText } = spec.injection;
  if (!searchPattern || replaceText === undefined) {
    return { modifiedPlan: plan, applied: false };
  }

  const regex = new RegExp(searchPattern, "i");
  const match = regex.test(plan);
  if (!match) {
    return { modifiedPlan: plan, applied: false };
  }

  const modifiedPlan = plan.replace(regex, replaceText);
  return { modifiedPlan, applied: true };
}
