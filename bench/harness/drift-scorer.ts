import type { DriftDetection, DriftSpec } from "./types.js";

/** Negative/scope phrases that indicate the verifier flagged something as out of scope. */
const SCOPE_PHRASES = [
  "not requested",
  "out of scope",
  "beyond the scope",
  "wasn't asked",
  "wasn't requested",
  "unnecessary",
  "unrelated",
  "not part of",
  "not in the original",
  "scope creep",
  "over-engineered",
  "adds complexity",
  "not needed",
  "extraneous",
  "not mentioned",
  "not required",
  "goes beyond",
  "exceeds the",
  "outside the scope",
  "not aligned",
  "deferred",
  "later phase",
  "separate phase",
  "future phase",
  "phase 2",
  "phase 3",
  "not integrated",
  "half-designed",
  "half-specified",
  "wasted effort",
  "over-engineering",
];

/** Section headings related to alignment/scope (keyword anywhere in heading). */
const ALIGNMENT_SECTIONS =
  /#{1,4}\s*(?:[\w\s-]*?)(?:alignment|scope|completeness|intent|requirements?|concerns?|issues?|risks?|gaps?|problems?)/i;

/** Score drift detection from verifier output using three-tier strategy. */
export function scoreDriftDetection(
  verifierOutput: string,
  spec: DriftSpec,
): DriftDetection {
  const base: Pick<DriftDetection, "specId" | "category" | "injectionApplied"> = {
    specId: spec.id,
    category: spec.category,
    injectionApplied: true,
  };

  // Tier 1: Critical callout — signal keyword near a negative/scope phrase
  const tier1 = checkCriticalCallout(verifierOutput, spec.expectedSignals);
  if (tier1) {
    return {
      ...base,
      detected: true,
      method: "critical-callout",
      matchedSignals: tier1,
    };
  }

  // Tier 2: Alignment section — signal keyword in a scope/alignment section
  const tier2 = checkAlignmentSection(verifierOutput, spec.expectedSignals);
  if (tier2) {
    return {
      ...base,
      detected: true,
      method: "alignment-section",
      matchedSignals: tier2,
    };
  }

  // Tier 3: Signal match — ≥40% of expected signals appear anywhere
  const tier3 = checkSignalMatch(verifierOutput, spec.expectedSignals);
  if (tier3) {
    return {
      ...base,
      detected: true,
      method: "signal-match",
      matchedSignals: tier3,
    };
  }

  return {
    ...base,
    detected: false,
    method: null,
    matchedSignals: [],
  };
}

/** Tier 1: Check if any signal keyword appears within 500 chars of a scope phrase. */
function checkCriticalCallout(
  output: string,
  signals: string[],
): string[] | null {
  const lowerOutput = output.toLowerCase();
  const matched: string[] = [];

  for (const signal of signals) {
    const signalLower = signal.toLowerCase();
    let searchFrom = 0;

    while (true) {
      const idx = lowerOutput.indexOf(signalLower, searchFrom);
      if (idx === -1) break;

      // Check window of 500 chars around the signal
      const windowStart = Math.max(0, idx - 500);
      const windowEnd = Math.min(lowerOutput.length, idx + signalLower.length + 500);
      const window = lowerOutput.slice(windowStart, windowEnd);

      for (const phrase of SCOPE_PHRASES) {
        if (window.includes(phrase)) {
          matched.push(signal);
          break;
        }
      }

      if (matched.includes(signal)) break;
      searchFrom = idx + 1;
    }
  }

  return matched.length > 0 ? matched : null;
}

/** Tier 2: Check if any signal keyword appears in an alignment/scope section. */
function checkAlignmentSection(
  output: string,
  signals: string[],
): string[] | null {
  const matched: string[] = [];

  for (const match of output.matchAll(new RegExp(ALIGNMENT_SECTIONS, "gi"))) {
    const afterSection = output.slice(match.index);
    const nextHeading = afterSection.slice(1).search(/^#{1,4}\s/m);
    const sectionText = (
      nextHeading === -1 ? afterSection : afterSection.slice(0, nextHeading + 1)
    ).toLowerCase();

    for (const signal of signals) {
      if (sectionText.includes(signal.toLowerCase()) && !matched.includes(signal)) {
        matched.push(signal);
      }
    }
  }

  return matched.length > 0 ? matched : null;
}

/** Tier 3: Check if ≥40% of expected signals appear anywhere in the output. */
function checkSignalMatch(
  output: string,
  signals: string[],
): string[] | null {
  if (signals.length === 0) return null;

  const lowerOutput = output.toLowerCase();
  const matched = signals.filter((s) => lowerOutput.includes(s.toLowerCase()));
  const threshold = Math.ceil(signals.length * 0.4);

  return matched.length >= threshold ? matched : null;
}
