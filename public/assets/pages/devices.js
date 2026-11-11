import { api, enc } from '../lib/api.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { confirmDialog, dataTable, field, fmtDate, formModal, listView, modal, osLabel, pageHeader, select, toast, when } from '../lib/ui.js';
import { connectionColumns } from './common.js';

async function loadUsers() {
  const data = await api.get('/users?pageSize=500');
  return data.items;
}

function ownerOptions(users) {
  return [['', 'Unassigned'], ...users.map((u) => [u.id, u.display_name ? `${u.username} (${u.display_name})` : u.username])];
}

function editDevice(device, users, onSaved) {
  formModal({
    title: `Edit device ${device.id}`,
    fields: [
      field('Owner', select('owner_id', ownerOptions(users), device.owner_id ?? ''), 'Devices are assigned automatically to the account that signs in on them.'),
      field('Note', h('textarea', { name: 'note', maxlength: 1000 }, device.note ?? '')),
    ],
    async onSubmit(form) {
      await api.patch(`/devices/${enc(device.id)}`, {
        owner_id: form.elements.owner_id.value || null,
        note: form.elements.note.value,
      });
      toast('Device updated');
      onSaved();
    },
  });
}

async function deleteDevice(device, onDeleted) {
  const ok = await confirmDialog(
    `Remove ${device.id}${device.hostname ? ` (${device.hostname})` : ''} from the device list? It will reappear the next time it sends a heartbeat. Connection logs are kept.`,
    { title: 'Remove device', confirmLabel: 'Remove' },
  );
  if (!ok) return;
  await api.del(`/devices/${enc(device.id)}`);
  toast('Device removed');
  onDeleted();
}

async function showDevice(id, users, reload) {
  const { device: d, connections } = await api.get(`/devices/${enc(id)}`);
  const info = Object.entries(d.sysinfo ?? {}).filter(([k, v]) => k !== 'id' && v !== '' && typeof v !== 'object');
  const m = modal({
    title: d.hostname ? `${d.hostname} · ${d.id}` : d.id,
    wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('span', { class: ['dot', d.online && 'on'] }),
        h('strong', null, d.online ? 'Online' : 'Offline'),
        h('span', { class: 'muted' }, d.last_seen_at ? `· last seen ${fmtDate(d.last_seen_at)}` : '· has not sent a heartbeat'),
      ),
      h('dl', { class: 'kv' },
        h('dt', null, 'RustDesk ID'), h('dd', { class: 'mono' }, d.id),
        h('dt', null, 'Owner'), h('dd', null, d.owner_username ?? h('span', { class: 'muted' }, 'Unassigned')),
        h('dt', null, 'Last IP'), h('dd', { class: 'mono' }, d.ip || '—'),
        h('dt', null, 'First seen'), h('dd', null, fmtDate(d.first_seen_at)),
        d.registered_at ? [h('dt', null, 'Registered in hbbs'), h('dd', null, fmtDate(d.registered_at))] : null,
        d.note ? [h('dt', null, 'Note'), h('dd', null, d.note)] : null,
      ),
      info.length
        ? h('div', null, h('h3', { class: 'small muted' }, 'SYSTEM INFORMATION'), h('dl', { class: 'kv' }, info.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, String(v))])))
        : h('p', { class: 'muted' }, 'No system information reported yet.'),
      h('div', null,
        h('h3', { class: 'small muted' }, 'RECENT CONNECTIONS'),
        h('div', { class: 'card' }, dataTable({ columns: connectionColumns.filter((c) => c.label !== 'Device'), rows: connections, empty: 'No connections to this device yet.' })),
        connections.length ? h('p', null, h('a', { href: `#/connections?device=${enc(d.id)}`, onclick: () => m.close() }, 'All connections for this device')) : null,
      ),
    ),
    footer: [
      h('button', { type: 'button', class: 'btn danger', onclick: () => { m.close(); deleteDevice(d, reload); } }, icon('trash'), 'Remove'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { m.close(); editDevice(d, users, reload); } }, icon('edit'), 'Edit'),
    ],
  });
}

export default {
  title: 'Devices',
  async render({ root, query }) {
    root.append(pageHeader('Devices', 'Machines that report to this server, plus any peers registered in hbbs.'));
    const users = await loadUsers();
    const list = listView({
      endpoint: '/devices',
      searchPlaceholder: 'Search ID, hostname, user, IP, note…',
      initial: { q: query.get('q') ?? '', filters: { status: query.get('status') ?? '', owner: query.get('owner') ?? '' } },
      filters: [
        { name: 'status', label: 'Status', options: [['', 'All devices'], ['online', 'Online'], ['offline', 'Offline']] },
        { name: 'owner', label: 'Owner', options: [['', 'Any owner'], ['none', 'Unassigned'], ...users.map((u) => [u.id, u.username])] },
      ],
      empty: "No devices yet. Set a RustDesk client's API server to this address and it will appear here.",
      onRowClick: (d) => showDevice(d.id, users, () => list.reload()),
      columns: [
        {
          label: 'Device',
          render: (d) => h('div', { class: 'id-cell' },
            h('span', { class: ['dot', d.online && 'on'], title: d.online ? 'Online' : 'Offline' }),
            h('div', null, h('div', { class: 'mono primary-cell' }, d.id), h('div', { class: 'sub' }, d.hostname || '—')),
          ),
        },
        { label: 'System', class: 'hide-sm', render: (d) => h('div', null, osLabel(d.os) || '—', d.username ? h('div', { class: 'sub' }, d.username) : null) },
        { label: 'Version', class: 'hide-sm', render: (d) => d.version || '—' },
        { label: 'Owner', render: (d) => d.owner_username ?? h('span', { class: 'muted' }, 'Unassigned') },
        { label: 'Note', class: 'hide-sm', render: (d) => d.note ? h('span', { title: d.note }, d.note.length > 40 ? `${d.note.slice(0, 40)}…` : d.note) : '' },
        {
          label: 'Last seen',
          render: (d) => d.online
            ? h('span', { class: 'row' }, 'Online', d.active_conns ? h('span', { class: 'badge success' }, `${d.active_conns} session${d.active_conns > 1 ? 's' : ''}`) : null)
            : d.last_seen_at ? when(d.last_seen_at) : h('span', { class: 'muted', title: 'Known to hbbs, but has not contacted the API server' }, 'Registered only'),
        },
        {
          label: '',
          class: 'actions',
          render: (d) => [
            h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${d.id}`, onclick: () => editDevice(d, users, () => list.reload()) }, icon('edit')),
            h('button', { type: 'button', class: 'icon-btn danger', title: 'Remove', 'aria-label': `Remove ${d.id}`, onclick: () => deleteDevice(d, () => list.reload()) }, icon('trash')),
          ],
        },
      ],
    });
    root.append(list.el);
  },
};
