// app/lib/catalog.ts
// Cascading filter data: Org → Sport → Levels

export const CATALOG: Record<string, Record<string, string[]>> = {
  NACSW: {
    Nosework: ['NW1', 'NW2', 'NW3', 'Elite', 'Summit'],
  },
  AKC: {
    'Nosework/Scent Work': ['Novice', 'Advanced', 'Excellent', 'Master', 'Detective'],
    Agility:    ['Novice', 'Open', 'Excellent', 'Master', 'Premier'],
    Rally:      ['Novice', 'Intermediate', 'Advanced', 'Excellent', 'Master'],
    Obedience:  ['Novice', 'Open', 'Utility'],
  },
  UKI: {
    Agility: ['Beginners', 'Novice', 'Senior', 'Champion'],
  },
  CPE: {
    Agility: ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'C'],
  },
  NADAC: {
    Agility: ['Intro', 'Novice', 'Open', 'Elite'],
  },
  UKC: {
    Nosework: ['Novice', 'Advanced', 'Superior', 'Elite'],
  },
  BHA: {
    'Barn Hunt': ['Instinct', 'Novice', 'Open', 'Senior', 'Master', 'Champion'],
  },
};

// Sport → Levels for sports not tied to a specific org
export const SPORT_LEVELS: Record<string, string[]> = {
  'Dock Diving': ['Novice', 'Junior', 'Senior', 'Master', 'Elite'],
};

export const ALL_ORGS = [
  'NACSW', 'AKC', 'UKI', 'CPE', 'NADAC', 'UKC',
  'WCRL', 'NAFA', 'USDAA', 'TDAA', 'ASCA', 'BHA', 'Other',
];

export const ALL_SPORTS = [
  'Nosework', 'Nosework/Scent Work', 'Agility', 'Rally', 'Obedience',
  'Barn Hunt', 'Dock Diving', 'FastCAT', 'Flyball', 'Tracking',
  'Herding', 'Lure Coursing', 'Conformation', 'Other',
];

/** Sports available for a single org (used in Find Trials single-select) */
export function getSportsForOrg(org: string): string[] {
  if (!org || org === 'All Orgs') return ALL_SPORTS;
  return Object.keys(CATALOG[org] ?? {});
}

/** Levels for an org+sport combo (used in Find Trials single-select) */
export function getLevelsForOrgSport(org: string, sport: string): string[] {
  if (!sport || sport === 'All Sports') return [];
  if (SPORT_LEVELS[sport]) return SPORT_LEVELS[sport];
  if (org && org !== 'All Orgs') return CATALOG[org]?.[sport] ?? [];
  // No org selected — union from all orgs
  const set = new Set<string>();
  for (const orgSports of Object.values(CATALOG)) {
    (orgSports[sport] ?? []).forEach(l => set.add(l));
  }
  return [...set];
}

/** Sports available for multiple selected orgs (used in Preferences multi-select) */
export function getSportsForOrgs(orgs: string[]): string[] {
  if (!orgs.length) return ALL_SPORTS;
  const set = new Set<string>();
  for (const org of orgs) {
    Object.keys(CATALOG[org] ?? {}).forEach(s => set.add(s));
  }
  return [...set];
}

/** Levels available for multiple selected orgs + sports (used in Preferences multi-select) */
export function getLevelsForPrefs(orgs: string[], sports: string[]): string[] {
  if (!sports.length) return [];
  const set = new Set<string>();
  for (const sport of sports) {
    if (SPORT_LEVELS[sport]) {
      SPORT_LEVELS[sport].forEach(l => set.add(l));
      continue;
    }
    const searchOrgs = orgs.length ? orgs : Object.keys(CATALOG);
    for (const org of searchOrgs) {
      (CATALOG[org]?.[sport] ?? []).forEach(l => set.add(l));
    }
  }
  return [...set];
}

/** Normalize a level string for case-insensitive comparison
 *  Also maps DB abbreviations (ELT → elite, SMT → summit) to full names */
const ABBREV: Record<string, string> = { elt: 'elite', smt: 'summit' };
export function normalizeLevel(level: string): string {
  const l = (level ?? '').toLowerCase().trim();
  return ABBREV[l] ?? l;
}
