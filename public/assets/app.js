import { api, onUnauthorized } from './lib/api.js';
import { clear, h } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { errorBox, field, input, toast } from './lib/ui.js';
import account from './pages/account.js';
import activity from './pages/activity.js';
import addressBooks from './pages/address-books.js';
import connections from './pages/connections.js';
import dashboard from './pages/dashboard.js';
import devices from './pages/devices.js';
import files from './pages/files.js';
import remote from './pages/remote.js';
import settings from './pages/settings.js';
import users from './pages/users.js';

const NAV = [
  { section: null, items: [['', 'Dashboard', 'grid', dashboard]] },
  { section: 'Manage', items: [['connect', 'Remote session', 'remote', remote], ['devices', 'Devices', 'monitor', devices], ['users', 'Users', 'users', users], ['address-books', 'Address books', 'book', addressBooks]] },
  { section: 'Audit', items: [['connections', 'Connections', 'link', connections], ['files', 'File transfers', 'file', files], ['activity', 'Activity', 'activity', activity]] },
  { section: 'System', items: [['settings', 'Settings', 'sliders', settings]] },
];

const PAGES = Object.fromEntries(NAV.flatMap((g) => g.items.map(([path, , , page]) => [path, page])));
PAGES.account = account;

const notFound = {
  title: 'Not found',
  render: ({ root }) => root.append(h('div', { class: 'empty-state' }, h('h2', null, 'Page not found'), h('p', null, h('a', { href: '#/' }, 'Back to the dashboard')))),
};

const app = document.getElementById('app');
let session = null;

onUnauthorized(() => {
  if (!session) return;
  session = null;
  toast('Your session has ended. Please sign in again.', 'error');
  route();
});

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  return { section: parts[0] ?? '', params: parts.slice(1), query: new URLSearchParams(qs) };
}

function brand() {
  return h('div', { class: 'brand' },
    h('img', { src: '/assets/favicon.svg', alt: '' }),
    h('div', null, 'RustDesk Web', h('small', null, 'Admin console')),
  );
}

function renderShell(active) {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
  for (const group of NAV) {
    if (group.section) nav.append(h('div', { class: 'nav-section' }, group.section));
    for (const [path, label, iconName] of group.items) {
      nav.append(h('a', { href: `#/${path}`, class: path === active && 'active', 'aria-current': path === active ? 'page' : null }, icon(iconName), label));
    }
  }
  const user = session.user;
  const shell = h('div', { class: 'shell' });
  const closeNav = () => shell.classList.remove('nav-open');
  nav.addEventListener('click', closeNav);

  const sidebar = h('aside', { class: 'sidebar' },
    brand(),
    nav,
    h('div', { class: 'sidebar-footer' },
      h('div', { class: 'who' }, h('strong', null, user.display_name || user.username), user.username),
      // AGPL-3.0 §13: users of the service are offered its source.
      h('a', { class: 'source-link', href: session.source_url, target: '_blank', rel: 'noopener' }, `Source code · v${session.version}`),
      h('div', { class: 'nav' },
        h('a', { href: '#/account', class: active === 'account' && 'active', onclick: closeNav }, icon('user'), 'My account'),
        h('a', { href: '#/', onclick: logout }, icon('logout'), 'Sign out'),
      ),
    ),
  );
  const topbar = h('div', { class: 'topbar' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Open menu', onclick: () => shell.classList.toggle('nav-open') }, icon('menu')),
    h('strong', null, 'RustDesk Web'),
  );
  const main = h('main', { class: 'main', id: 'main' });
  shell.append(sidebar, h('div', null, topbar, main));
  clear(app).append(shell);
  return main;
}

async function logout(e) {
  e.preventDefault();
  try {
    await api.post('/logout');
  } finally {
    session = null;
    location.hash = '#/';
    route();
  }
}

function renderLogin() {
  document.title = 'Sign in · RustDesk Web Admin';
  const error = h('div', { class: 'form-error hidden', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Sign in');
  const form = h('form', { class: 'form' },
    error,
    field('Username', input('username', { autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' })),
    field('Password', input('password', { type: 'password', autocomplete: 'current-password', required: true })),
    submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.classList.add('hidden');
    try {
      await api.post('/login', { username: form.elements.username.value.trim(), password: form.elements.password.value });
      session = await api.get('/me');
      route();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      form.elements.password.select();
    } finally {
      submit.disabled = false;
    }
  });
  clear(app).append(h('div', { class: 'login' }, h('div', { class: 'card' },
    brand(),
    h('h1', null, 'Sign in'),
    h('p', { class: 'muted' }, 'Use an administrator account.'),
    form,
  )));
  form.elements.username.focus();
}

async function route() {
  if (!session) return renderLogin();
  const { section, params, query } = parseHash();
  const page = PAGES[section] ?? notFound;
  // Full-screen pages (the remote viewer) render without the admin chrome.
  const main = page.fullscreen ? clear(app).appendChild(h('main', { class: 'main-full' })) : renderShell(section);
  document.title = `${page.title} · RustDesk Web Admin`;
  try {
    await page.render({ root: main, params, query, session });
  } catch (err) {
    if (err.status !== 401) main.append(errorBox(err));
  }
}

window.addEventListener('hashchange', route);

// Errors from button handlers (delete, revoke, save...) surface as toasts.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.status === 401) return;
  toast(e.reason?.message ?? String(e.reason), 'error');
});

(async function boot() {
  try {
    session = await api.get('/me');
  } catch (err) {
    session = null;
    if (err.status !== 401 && err.status !== 403) {
      clear(app).append(h('div', { class: 'login' }, errorBox(err)));
      return;
    }
  }
  route();
})();
