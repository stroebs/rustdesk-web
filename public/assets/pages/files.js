import { h } from '../lib/dom.js';
import { dataTable, fmtDate, listView, modal, pageHeader, when } from '../lib/ui.js';
import { deviceCell } from './common.js';

// Values of the client's FileAuditType, seen from the controlled device.
const DIRECTIONS = { 0: 'Sent by remote', 1: 'Received by remote' };

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function showFiles(entry) {
  modal({
    title: 'File transfer',
    wide: true,
    body: h('div', { class: 'stack' },
      h('dl', { class: 'kv' },
        h('dt', null, 'Time'), h('dd', null, fmtDate(entry.created_at)),
        h('dt', null, 'Device'), h('dd', { class: 'mono' }, entry.device_id),
        h('dt', null, 'Remote'), h('dd', null, [entry.peer_id, entry.peer_name].filter(Boolean).join(' · ') || '—'),
        h('dt', null, 'Direction'), h('dd', null, DIRECTIONS[entry.direction] ?? '—'),
        h('dt', null, 'Path'), h('dd', { class: 'mono' }, entry.path),
      ),
      h('div', { class: 'card' }, dataTable({
        rows: entry.files,
        empty: 'No file details were reported.',
        columns: [
          { label: 'Name', render: (f) => h('span', { class: 'mono' }, Array.isArray(f) ? String(f[0]) : String(f?.name ?? f)) },
          { label: 'Size', render: (f) => formatBytes(Array.isArray(f) ? Number(f[1]) : Number(f?.size)) },
        ],
      })),
    ),
  });
}

export default {
  title: 'File transfers',
  render({ root }) {
    root.append(pageHeader('File transfers', 'Files sent to or received from devices during remote sessions.'));
    const list = listView({
      endpoint: '/audit/files',
      searchPlaceholder: 'Search device, peer, path, IP…',
      empty: 'No file transfers recorded yet.',
      onRowClick: showFiles,
      columns: [
        { label: 'Time', render: (f) => when(f.created_at) },
        { label: 'Device', render: (f) => deviceCell(f.device_id, f.hostname) },
        { label: 'Remote', render: (f) => h('div', null, h('span', { class: 'mono' }, f.peer_id || '—'), f.peer_name ? h('div', { class: 'sub' }, f.peer_name) : null) },
        { label: 'Direction', class: 'hide-sm', render: (f) => DIRECTIONS[f.direction] ?? '—' },
        { label: 'Path', render: (f) => h('span', { class: 'mono', title: f.path }, f.path.length > 60 ? `…${f.path.slice(-60)}` : f.path) },
        { label: 'Files', class: 'hide-sm', render: (f) => String(f.file_count) },
        { label: 'IP', class: 'hide-sm', render: (f) => h('span', { class: 'mono' }, f.ip || '—') },
      ],
    });
    root.append(list.el);
  },
};
