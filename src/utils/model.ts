/**
 * Thinking levels supported via model-name suffix, e.g. `claude-fable-5-max`.
 * - `off` means thinking is disabled (model name has no suffix).
 * - `max` maps to upstream value `xhigh`.
 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** Upstream accepts these literal values in `reasoning_effort`. */
export type UpstreamReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

const SUFFIX_TO_LEVEL: Record<string, ThinkingLevel> = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

const LEVEL_TO_UPSTREAM: Record<Exclude<ThinkingLevel, 'off'>, UpstreamReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
};

export interface ParsedModel {
  /** Model identifier without the thinking suffix, sent to the upstream. */
  baseModel: string;
  /** Thinking level derived from the model name suffix; `off` when absent. */
  thinking: ThinkingLevel;
}

/**
 * Splits a model id like `claude-fable-5-max` into `{ baseModel: "claude-fable-5", thinking: "max" }`.
 * An unknown trailing token is treated as part of the base model (no thinking suffix).
 */
export function parseModel(model: string): ParsedModel {
  const parts = model.split('-');
  const last = parts[parts.length - 1];
  const level = SUFFIX_TO_LEVEL[last?.toLowerCase()];

  if (!level) {
    return { baseModel: model, thinking: 'off' };
  }

  // Reconstruct the base model without the last segment.
  const baseModel = parts.slice(0, -1).join('-');
  return { baseModel: baseModel || model, thinking: level };
}

/**
 * Converts a thinking level to the upstream `reasoning_effort` value.
 * Returns `null` for `off` (the field should be omitted upstream).
 */
export function thinkingToUpstream(thinking: ThinkingLevel): UpstreamReasoningEffort | null {
  if (thinking === 'off') return null;
  return LEVEL_TO_UPSTREAM[thinking];
}
