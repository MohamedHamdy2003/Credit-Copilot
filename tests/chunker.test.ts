import { splitWithOverlap, tokenCount } from '../packages/infrastructure/src/parsers/chunker.js';
it('limits oversized clauses to800 cl100k tokens with60-token overlap', () => {
  const text = Array.from({ length: 1800 }, (_, i) => `term${i}`).join(' ');
  const parts = splitWithOverlap(text);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every((p) => tokenCount(p) <= 800)).toBe(true);
  expect(parts[0]!.slice(-20)).toBeTruthy();
  expect(parts[1]!).toContain(parts[0]!.trim().split(' ').slice(-8).join(' '));
});
it('preserves short clauses and tables exactly', () => {
  const text = 'Role | Authority\nCredit Officer | 250,000';
  expect(splitWithOverlap(text)).toEqual([text]);
});
