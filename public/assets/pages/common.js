import { h } from '../lib/dom.js';
import { badge, duration, when } from '../lib/ui.js';

export const CONN_TYPES = {
  0: 'Remote desktop',
  1: 'File transfer',
  2: 'Port forward',
  3: 'View camera',
  4: 'Terminal',
};

export function deviceCell(id, hostname, online) {
  return h('div', { class: 'id-cell' },
    online === undefined ? null : h('span', { class: ['dot', online && 'on'], title: online ? 'Online' : 'Offline' }),
    h('div', null, h('a', { href: `#/devices?q=${encodeURIComponent(id)}`, class: 'mono primary-cell' }, id), hostname ? h('div', { class: 'sub' }, hostname) : null),
  );
}

export function connectionStatus(c) {
  if (c.ended_at) return h('span', { class: 'nowrap' }, duration(c.ended_at - c.started_at));
  if (c.device_online) return badge('Active', 'success');
  return h('span', { class: 'muted', title: 'The device went offline before reporting the end of this session' }, 'Unknown');
}

export const connectionColumns = [
  { label: 'Started', render: (c) => when(c.started_at) },
  { label: 'Device', render: (c) => deviceCell(c.device_id, c.hostname) },
  {
    label: 'From',
    render: (c) => c.peer_id || c.peer_name
      ? h('div', null, h('span', { class: 'mono' }, c.peer_id || '—'), c.peer_name ? h('div', { class: 'sub' }, c.peer_name) : null)
      : h('span', { class: 'muted' }, '—'),
  },
  { label: 'IP', class: 'hide-sm', render: (c) => (c.ip ? h('span', { class: 'mono' }, c.ip) : '—') },
  { label: 'Type', class: 'hide-sm', render: (c) => (c.conn_type == null ? '—' : CONN_TYPES[c.conn_type] ?? `Type ${c.conn_type}`) },
  { label: 'Duration', render: connectionStatus },
];
