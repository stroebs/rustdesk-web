import { h } from '../lib/dom.js';
import { badge, listView, pageHeader, when } from '../lib/ui.js';

const LABELS = {
  login: ['Console sign-in', 'success'],
  login_failed: ['Console sign-in failed', 'danger'],
  client_login: ['Client sign-in', 'success'],
  client_login_failed: ['Client sign-in failed', 'danger'],
  client_alarm: ['Client alarm', 'warn'],
  password_change: ['Password changed', 'accent'],
  user_create: ['User created', 'accent'],
  user_update: ['User updated', 'accent'],
  user_delete: ['User deleted', 'warn'],
  session_revoke: ['Session revoked', 'warn'],
  device_update: ['Device updated', 'accent'],
  device_delete: ['Device removed', 'warn'],
  address_book_update: ['Address book edited', 'accent'],
  settings_update: ['Settings changed', 'accent'],
};

export default {
  title: 'Activity',
  render({ root }) {
    root.append(pageHeader('Activity', 'Sign-ins and administrative changes.'));
    const list = listView({
      endpoint: '/activity',
      searchPlaceholder: 'Search user, action, target, IP…',
      empty: 'No activity yet.',
      columns: [
        { label: 'Time', render: (a) => when(a.created_at) },
        { label: 'Action', render: (a) => { const [label, variant] = LABELS[a.action] ?? [a.action, '']; return badge(label, variant); } },
        { label: 'By', render: (a) => a.username || h('span', { class: 'muted' }, '—') },
        { label: 'Target', render: (a) => (a.target ? h('span', { class: 'mono' }, a.target) : '—') },
        { label: 'Details', class: 'hide-sm', render: (a) => (a.detail ? h('span', { class: 'muted', title: a.detail }, a.detail.length > 80 ? `${a.detail.slice(0, 80)}…` : a.detail) : '') },
        { label: 'IP', class: 'hide-sm', render: (a) => h('span', { class: 'mono' }, a.ip || '—') },
      ],
    });
    root.append(list.el);
  },
};
