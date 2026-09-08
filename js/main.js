// Bootstrap.

import { supa, isConfigured } from './lib/supa.js';
import { loadSession, loadOrCreateProfiles } from './lib/auth.js';
import { mountProfileSwitcher } from './lib/profile.js';
import { defineRoot, defineRoute, startRouter, render as routerRender } from './lib/router.js';
import { getState, subscribe } from './lib/state.js';
import { renderSignIn, renderNoProfile, refreshTournamentCountdown } from './views/shell.js';
import { drain, queueSize } from './lib/offline.js';

import { mountDashboard } from './modules/dashboard.js';
import { mountBoutsList, mountBoutEntry, mountBoutDetail } from './modules/bouts.js';
import { mountOpponentsList, mountOpponentDetail, mountScoutForm } from './modules/opponents.js';
import { mountPhysical } from './modules/physical.js';
import { mountMental } from './modules/mental.js';
import { mountLessons } from './modules/lessons.js';
import { mountTrain } from './modules/train.js';
import { mountInsight } from './modules/insight.js';
import { mountSeason } from './modules/season.js';
import { mountNavMore } from './lib/nav-more.js';
mountNavMore();
import { mountTournaments } from './modules/tournaments.js';
import { mountTournamentDay } from './modules/tournament-day.js';
import { mountImportV1 } from './modules/import_v1.js';
import { mountVideos } from './modules/videos.js';
import { mountTravel } from './modules/travel.js';
import { mountStyle } from './modules/style.js';

const APP = document.getElementById('app');

defineRoot(APP);

defineRoute('dashboard', mountDashboard);
defineRoute('bouts', mountBoutsList);
defineRoute('bouts/new', mountBoutEntry);
defineRoute('bouts/edit', mountBoutEntry);
defineRoute('bouts/show', mountBoutDetail);
defineRoute('opponents', mountOpponentsList);
defineRoute('opponents/show', mountOpponentDetail);
defineRoute('opponents/scout', mountScoutForm);
defineRoute('physical', mountPhysical);
defineRoute('mental', mountMental);
defineRoute('lessons', mountLessons);
defineRoute('train', mountTrain);
defineRoute('insight', mountInsight);
defineRoute('season', mountSeason);
defineRoute('videos', mountVideos);
defineRoute('style', mountStyle);
defineRoute('travel', mountTravel);
defineRoute('tournaments', mountTournaments);
defineRoute('tournaments/day', mountTournamentDay);
defineRoute('import-v1', mountImportV1);

async function bootstrap() {
    if (!isConfigured()) {
        renderSignIn(APP);
        return;
    }
    const session = await loadSession();
    if (!session) {
        renderSignIn(APP);
        return;
    }
    const profiles = await loadOrCreateProfiles(session.user.id);
    if (!profiles.length) {
        // Signed in successfully, but this account has no fencer attached to
        // it. Almost always the wrong Google account was picked, so name the
        // account: that is the fact which makes the mistake obvious.
        renderNoProfile(APP, session.user.email);
        return;
    }
    mountProfileSwitcher();
    startRouter();
    setupBottomNavActive();
    refreshTournamentCountdown();

    // when active profile changes, re-render
    subscribe(((prev) => (s) => {
        if (s.activeProfileId !== prev) {
            prev = s.activeProfileId;
            routerRender();
            refreshTournamentCountdown();
        }
    })(getState().activeProfileId));

    // service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW failed', e));
    }

    // offline banner + queue drain
    const banner = document.getElementById('offline-banner');
    function refreshBanner() {
        const q = window.__queueSize || 0;
        if (!navigator.onLine || q > 0) {
            banner.hidden = false;
            banner.textContent = navigator.onLine
                ? `Syncing ${q} pending change${q === 1 ? '' : 's'}…`
                : `Offline · ${q ? q + ' change(s) queued' : 'changes will sync when you reconnect'}`;
        } else {
            banner.hidden = true;
        }
    }
    async function tickQueue() {
        window.__queueSize = await queueSize();
        refreshBanner();
    }
    window.addEventListener('online', () => { drain().then(tickQueue); refreshBanner(); });
    window.addEventListener('offline', refreshBanner);
    setInterval(tickQueue, 5000);
    tickQueue();

    // listen for auth state changes (e.g. token refresh, sign-out from another tab)
    supa.auth.onAuthStateChange(async (event, sess) => {
        if (event === 'SIGNED_OUT' || !sess) {
            location.reload();
        }
    });
}


function setupBottomNavActive() {
    const nav = document.getElementById('bottom-nav');
    if (!nav) return;
    function update() {
        const hash = (location.hash || '#dashboard').slice(1).split('/')[0].split('?')[0];
        nav.querySelectorAll('a').forEach((a) => {
            const route = a.getAttribute('data-route');
            a.classList.toggle('is-active', route === hash);
        });
    }
    window.addEventListener('hashchange', update);
    update();
}



// =====================================================
// Phase 2 — Floating Action Button (always accessible "+ Log a bout")
// =====================================================
function setupFAB() {
    if (document.getElementById('fab-log-bout')) return;
    const fab = document.createElement('a');
    fab.id = 'fab-log-bout';
    fab.className = 'fab fab-primary';
    fab.href = '#bouts/new';
    fab.setAttribute('aria-label', 'Log a bout');
    fab.innerHTML = '<span class="fab-icon">+</span><span class="fab-label">Log bout</span>';
    document.body.appendChild(fab);

    function update() {
        const hash = (location.hash || '#dashboard').slice(1).split('/')[0].split('?')[0];
        // Hide on the bout-entry route itself
        fab.style.display = (hash === 'bouts' && /^#bouts\/new/.test(location.hash)) ? 'none' : '';
    }
    window.addEventListener('hashchange', update);
    update();
}


bootstrap().catch((e) => {
    console.error(e);
    APP.innerHTML = `<div class="card" style="margin-top:40px"><h3 style="color:var(--danger)">Couldn't start the app.</h3><pre class="mono dim">${e?.message || e}</pre></div>`;
});
