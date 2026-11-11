import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
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
  if (c.ended_at) {
    return c.end_inferred
      ? h('span', { class: 'nowrap', title: 'The device never reported the end of this session; the end time is when it was last seen open.' }, `≈ ${duration(c.ended_at - c.started_at)}`)
      : h('span', { class: 'nowrap' }, duration(c.ended_at - c.started_at));
  }
  if (c.active) return badge('Active', 'success');
  return h('span', {
    class: 'muted',
    title: c.device_online
      ? 'Waiting for the device to confirm this session in its next heartbeat'
      : 'The device went offline before reporting the end of this session',
  }, 'Unknown');
}

/**
 * Sessions a device reports as open in its heartbeat but that have no log entry,
 * typically because they started while the API server was unreachable.
 */
export function unrecordedNotice(list) {
  if (!list?.length) return null;
  const total = list.reduce((n, u) => n + u.count, 0);
  return h('div', { class: 'callout' }, icon('alert'),
    h('div', null,
      h('strong', null, `${total} open session${total === 1 ? '' : 's'} not in the log`),
      h('p', null,
        'Reported as open by ',
        list.map((u, i) => [i ? ', ' : '', h('a', { href: `#/devices?q=${encodeURIComponent(u.device_id)}` }, u.hostname || u.device_id), u.count > 1 ? ` (${u.count})` : '']),
        '. These sessions started while this server could not record them, for example while it was down. RustDesk does not resend missed events, so they will not appear here. New sessions are logged normally.',
      ),
    ),
  );
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
