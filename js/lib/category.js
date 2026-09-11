// A fencer's home category from the birth year, for the 2026-27 season.
// USA Fencing youth ages run on birth year: Y10 born 2016-2017, Y12 2014-2015,
// Y14 2012-2013; Cadet is under 17 on 1 Jan (born 2010 or later), Junior
// under 20 (born 2007 or later). The season rolls each August.
export const SEASON_START_YEAR = 2026;

export function categoryFor(birthYear) {
    const by = Number(birthYear);
    if (!by) return null;
    if (by >= SEASON_START_YEAR - 10) return 'y10';
    if (by >= SEASON_START_YEAR - 12) return 'y12';
    if (by >= SEASON_START_YEAR - 14) return 'y14';
    if (by >= SEASON_START_YEAR - 16) return 'cadet';
    if (by >= SEASON_START_YEAR - 19) return 'junior';
    return 'senior';
}

// The categories a fencer may enter this season, youngest first.
export function categoriesFor(birthYear) {
    const by = Number(birthYear);
    if (!by) return [];
    const out = [];
    if (by >= SEASON_START_YEAR - 10 && by <= SEASON_START_YEAR - 9) out.push('y10');
    if (by >= SEASON_START_YEAR - 12 && by <= SEASON_START_YEAR - 9) out.push('y12');
    if (by >= SEASON_START_YEAR - 14 && by <= SEASON_START_YEAR - 11) out.push('y14');
    if (by >= SEASON_START_YEAR - 16 && by <= SEASON_START_YEAR - 11) out.push('cadet');
    if (by >= SEASON_START_YEAR - 19 && by <= SEASON_START_YEAR - 13) out.push('junior');
    if (by <= SEASON_START_YEAR - 13) out.push('div1');
    return out;
}

export const CATEGORY_LABEL = { y10: 'Y10', y12: 'Y12', y14: 'Y14', cadet: 'Cadet', junior: 'Junior', div1: 'Division I', senior: 'Senior' };

// A stable slug for profiles.role from a name: "Ava Chen" -> "ava-chen".
export function roleSlug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'fencer';
}
