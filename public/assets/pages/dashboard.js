import { api } from '../lib/api.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { dataTable, pageHeader, timeAgo } from '../lib/ui.js';
import { connectionColumns, unrecordedNotice } from './common.js';

function stat(label, value, sub, href, iconName) {
  return h(href ? 'a' : 'div', { class: 'card stat', href },
    h('span', { class: 'label' }, icon(iconName), label),
    h('span', { class: 'value' }, String(value)),
    sub ? h('span', { class: 'sub' }, sub) : null,
  );
}

export default {
  title: 'Dashboard',
  async render({ root }) {
    root.append(pageHeader('Dashboard', 'An overview of your RustDesk deployment.'));
    const s = await api.get('/stats');
    const body = h('div', { class: 'stack' });
    const unrecordedTotal = s.unrecorded_sessions.reduce((n, u) => n + u.count, 0);

    if (!s.server_configured) {
      body.append(h('div', { class: 'callout warn' }, icon('alert'),
        h('div', null,
          h('strong', null, 'Finish setting up client configuration'),
          h('p', null, 'Add your ID server and public key in ', h('a', { href: '#/settings' }, 'Settings'), ' to get a configuration string you can import into RustDesk clients.'),
        ),
      ));
    }
    if (s.hbbs.enabled && s.hbbs.error) {
      body.append(h('div', { class: 'callout danger' }, icon('alert'),
        h('div', null, h('strong', null, 'Cannot read the hbbs database'), h('p', null, s.hbbs.error)),
      ));
    }

    body.append(h('div', { class: 'stats' },
      stat('Online now', s.online, `of ${s.devices} device${s.devices === 1 ? '' : 's'}`, '#/devices?status=online', 'monitor'),
      stat('Active sessions', s.active_sessions, unrecordedTotal ? `${unrecordedTotal} not in the log` : 'on online devices', '#/connections', 'link'),
      stat('Connections', s.connections_24h, 'in the last 24 hours', '#/connections', 'activity'),
      stat('File transfers', s.files_24h, 'in the last 24 hours', '#/files', 'file'),
      stat('Users', s.users, `${s.admins} administrator${s.admins === 1 ? '' : 's'}`, '#/users', 'users'),
    ));

    body.append(unrecordedNotice(s.unrecorded_sessions) ?? '');
    body.append(h('div', { class: 'card' },
      h('div', { class: 'card-header' }, h('h2', null, 'Recent connections'), h('span', { class: 'spacer' }), h('a', { href: '#/connections' }, 'View all')),
      dataTable({
        columns: connectionColumns,
        rows: s.recent_connections,
        empty: 'No connections recorded yet. Clients report sessions once their API server points here.',
      }),
    ));

    if (s.hbbs.enabled && !s.hbbs.error && s.hbbs.lastSync) {
      body.append(h('p', { class: 'muted small' }, `hbbs: ${s.hbbs.peers} registered peers, synced ${timeAgo(s.hbbs.lastSync)}.`));
    }
    root.append(body);
  },
};
