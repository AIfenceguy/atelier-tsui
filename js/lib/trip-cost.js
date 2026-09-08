// Trip cost from the family's own door.
//
// A parent enters a home address once. From then on every weekend is priced
// from there: a drive if it is close enough to drive, otherwise a flight, with
// a flat hotel estimate. Flights are the only part worth tracking day to day,
// and the Travel screen does that; everything else here is an estimate and
// says so. One adult and one fencer.

const EARTH_MI = 3958.8;
export function milesBetween(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_MI * Math.asin(Math.sqrt(h));
}

// One-way fare per person by distance, the way domestic fares actually band.
export function fareEstimate(miles) {
    if (miles == null) return 190;
    if (miles < 700) return 120;
    if (miles < 1400) return 160;
    if (miles < 2200) return 200;
    return 240;
}

export const HOTEL_DEFAULT = 180;      // estimate only: $150-$250, 3.5-star and up near the venue
const LOCAL_MILES = 60;               // home and back the same day
const DRIVE_MILES = 320;              // beyond this, a flight wins on time and cost
const GAS_PER_MILE = 0.16;

// home: { lat, lng, hotel_night? }   venue: { lat, lng }   days: event days for this fencer
export function estimateTrip({ home, venue, days = 1, tier = 'regional' }) {
    const miles = milesBetween(home, venue);
    const entries = tier === 'nac' || tier === 'nationals' ? 115 : 60;
    const hotel_night = home?.hotel_night || HOTEL_DEFAULT;
    if (miles == null) return null;
    if (miles <= LOCAL_MILES) {
        const drive = Math.round(miles * 2 * GAS_PER_MILE * days);
        return { travel: 'local', miles: Math.round(miles), flight_pp: 0, nights: 0, hotel_night, drive, entries, total: drive + entries, basis: 'estimate' };
    }
    if (miles <= DRIVE_MILES) {
        const nights = Math.max(1, days);
        const drive = Math.round(miles * 2 * GAS_PER_MILE);
        return { travel: 'drive', miles: Math.round(miles), flight_pp: 0, nights, hotel_night, drive, entries, total: drive + nights * hotel_night + entries, basis: 'estimate' };
    }
    const flight_pp = fareEstimate(miles);
    const nights = days + 1;
    const drive = 50;   // airport runs and parking
    return { travel: 'fly', miles: Math.round(miles), flight_pp, nights, hotel_night, drive, entries, total: flight_pp * 2 * 2 + nights * hotel_night + drive + entries, basis: 'estimate' };
}

// Apply a live fare from a Travel-screen watch, when one matches the city and dates.
export function withLiveFare(cost, watches, latestPrice, city, startDate) {
    if (!cost || !city) return cost;
    const c = String(city).toLowerCase().split(',')[0].trim();
    const day = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00');
    const w = (watches || []).find((x) => Math.abs((day(x.depart_date) - day(startDate)) / 864e5) <= 4 && String(x.label || '').toLowerCase().includes(c));
    if (!w) return cost;
    let flight_pp = cost.flight_pp, live = false;
    const lp = latestPrice?.[w.id];
    const pp = lp?.effective_per_person ?? lp?.price_per_person;
    if (pp) { flight_pp = pp / 2; live = true; }
    if (w.booked_out_cash) { flight_pp = (Number(w.booked_out_cash) + Number(w.booked_ret_cash || 0)) / 2; live = true; }
    if (!live) return cost;
    return { ...cost, flight_pp, live: true, basis: 'live fare', total: flight_pp * 2 * 2 + cost.nights * cost.hotel_night + cost.drive + cost.entries };
}
