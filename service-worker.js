// En Garde — minimal app-shell SW.
// Caches the static shell so the app loads when wifi is bad at venues.
// Mutations go through the in-app offline queue (lib/offline.js), not the SW.

const SHELL_CACHE = 'en-garde-shell-v121';
const SHELL_FILES = [
    './',
    './index.html',
    './manifest.json',
    './css/style.css',
    './css/mobile-fix.css',
    './css/nav.css',
    './js/lib/nav-more.js',
    './js/main.js',
    './js/lib/config.js',
    './js/lib/supa.js',
    './js/vendor/supabase-js.js',
    './js/vendor/buffer.mjs',
    './js/lib/auth.js',
    './js/lib/profile.js',
    './js/lib/router.js',
    './js/lib/db.js',
    './js/lib/util.js',
    './js/lib/state.js',
    './js/lib/offline.js',
    './js/lib/chips.js',
    './js/lib/coaches.js',
    './js/lib/coach.js',
    './js/lib/priority-targets.js',
    './js/lib/levels.js',
    './js/lib/fencer-intel.js',
    './js/lib/fencer-intel.json',
    './js/lib/coach-ai.js',
    './js/lib/weakness-drills.js',
    './js/lib/drill-mastery.js',
    './js/lib/drill-coach.js',
    './js/lib/ftl-parser.js',
    './js/lib/milestones.js',
    './js/lib/avatars.js',
    './js/lib/level-up-modal.js',
    './js/lib/youtube.js',
    './js/lib/quick-bout.js',
    './js/lib/season-model.js',
    './js/lib/daily-tip.js',
    './js/lib/trip-cost.js',
    './js/lib/home-card.js',
    './js/lib/weekly-plan.js',
    './js/lib/visibility.js',
    './js/lib/lost-bouts.js',
    './js/modules/settings.js',
    './js/views/shell.js',
    './js/modules/dashboard.js',
    './js/modules/bouts.js',
    './js/modules/opponents.js',
    './js/modules/physical.js',
    './js/modules/mental.js',
    './js/modules/private_lessons.js',
    './js/modules/group_lessons.js',
    './js/modules/lessons.js',
    './js/modules/videos.js',
    './js/modules/train.js',
    './js/modules/insight.js',
    './js/modules/season.js',
    './js/modules/coach-review.js',
    './js/modules/travel.js',
    './js/modules/style.js',
    './js/modules/tournaments.js',
    './js/modules/tournament-day.js',
    './js/modules/import_v1.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(SHELL_CACHE).then((c) =>
            // best-effort: missing files don't block install
            Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => null)))
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // never intercept Supabase API calls — those need to go to network or fail
    if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;
    // never intercept Google fonts (they have their own caching)
    if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) return;
    // only handle GETs from same origin
    if (e.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    // Network-first, falling back to cache.
    //
    // This was previously cache-first with background revalidation, which meant
    // every deploy stayed invisible until the *second* load — so a fix would
    // appear to have done nothing, and a half-updated mix of old HTML with new
    // modules could be served. Offline still works: the cache is the fallback,
    // and it is refreshed on every successful fetch.
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(SHELL_CACHE).then((c) => c.put(e.request, clone));
                }
                return res;
            })
            .catch(async () => {
                const cached = await caches.match(e.request);
                if (cached) return cached;
                // Offline on a route we never cached: hand back the shell so the
                // hash router can still render something.
                if (e.request.mode === 'navigate') {
                    const shell = await caches.match('./index.html');
                    if (shell) return shell;
                }
                return Response.error();
            })
    );
});
