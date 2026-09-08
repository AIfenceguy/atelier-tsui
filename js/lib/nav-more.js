// The More tab: opens the bottom nav to two rows, closes it on any navigation.
export function mountNavMore() {
    const nav = document.getElementById('bottom-nav');
    if (!nav || nav.querySelector('.nav-more')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-more';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'More screens');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg><span class="nav-label">More</span>';
    btn.onclick = () => {
        const open = !nav.classList.contains('is-expanded');
        nav.classList.toggle('is-expanded', open);
        btn.setAttribute('aria-expanded', String(open));
        btn.querySelector('.nav-label').textContent = open ? 'Less' : 'More';
    };
    nav.appendChild(btn);
    // Any tab tap folds the row back.
    nav.addEventListener('click', (e) => {
        if (e.target.closest('a[data-route]') && nav.classList.contains('is-expanded')) btn.onclick();
    });
}
