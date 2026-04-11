/**
 * translationUtils.ts
 *
 * Rule-based post-translation correction system.
 * All correction rule data lives here; callers only invoke normalizeTranslation().
 */

export interface CorrectionRule {
  pattern:     RegExp;
  replace:     string;
  description: string;
}

// ── Phonetic corrections ──────────────────────────────────────────────────────
// Fix common LLM phonetic mis-renderings of English loanwords in Korean.
export const PHONETIC_CORRECTIONS: CorrectionRule[] = [
  {
    pattern:     /\b스카이\b/g,
    replace:     "차이",
    description: "chai mis-rendered as 스카이 → correct to 차이",
  },
];

// ── Domain term normalizations ────────────────────────────────────────────────
// Exact whole-word substitutions for known domain terms.
// Only applied when the term appears as a standalone word (word boundary match).
export const DOMAIN_TERMS: CorrectionRule[] = [
  {
    pattern:     /\b스팀\s?밀크\b/g,
    replace:     "스팀 우유",
    description: "steamed milk: normalize to Korean",
  },
  {
    pattern:     /\b라이트\s?워터\b/g,
    replace:     "물 조금",
    description: "light water: naturalize to Korean",
  },
];

// ── Master normalization function ─────────────────────────────────────────────
// Apply all rule sets in order: phonetic first, then domain terms.
// Each rule's pattern is reset (lastIndex = 0) before use to prevent
// stateful regex bugs with the /g flag.
export function normalizeTranslation(text: string): string {
  let result = text;

  for (const rule of [...PHONETIC_CORRECTIONS, ...DOMAIN_TERMS]) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(result)) {
      rule.pattern.lastIndex = 0;
      result = result.replace(rule.pattern, rule.replace);
    }
  }

  return result;
}
