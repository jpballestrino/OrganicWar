// Rank tiers from the ranked rating (shown on profiles and the rankings).
// A player with no ranked match is "Unranked", whatever their rating.
export const TIERS = [
  { name: 'Bronze', min: 0, color: '#cd7f32' },
  { name: 'Silver', min: 1100, color: '#c0c0c0' },
  { name: 'Gold', min: 1300, color: '#ffd700' },
  { name: 'Platinum', min: 1500, color: '#e5e4e2' },
  { name: 'Diamond', min: 1800, color: '#b9f2ff' },
];

export function tierFor(rating, rankedGames) {
  if (!rankedGames) return { name: 'Unranked', color: '#9ca3af', next: null };
  let i = 0;
  while (i + 1 < TIERS.length && rating >= TIERS[i + 1].min) i++;
  const next = TIERS[i + 1] || null;
  return { ...TIERS[i], next, toNext: next ? next.min - rating : 0 };
}

export const MODE_LABELS = { ranked: 'Ranked', quick: 'Quick', mega: 'Mega', guild: 'Guild War', custom: 'Custom', casual: 'Match' };

export const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
