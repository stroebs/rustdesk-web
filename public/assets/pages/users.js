import { api, enc } from '../lib/api.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { badge, checkbox, confirmDialog, dataTable, field, formModal, input, listView, modal, pageHeader, toast, when } from '../lib/ui.js';

function userForm(user = {}) {
  const editing = Boolean(user.id);
  return [
    h('div', { class: 'form-grid' },
      field('Username', input('username', { value: user.username ?? '', required: true, maxlength: 64, autocapitalize: 'none', spellcheck: 'false' }), 'Used to sign in from RustDesk.'),
      field('Display name', input('display_name', { value: user.display_name ?? '', maxlength: 100 })),
    ),
    field('Email', input('email', { type: 'email', value: user.email ?? '', maxlength: 254 })),
    field(
      editing ? 'New password' : 'Password',
      input('password', { type: 'password', autocomplete: 'new-password', minlength: 8, required: !editing }),
      editing ? 'Leave blank to keep the current password. Changing it signs the user out everywhere.' : 'At least 8 characters.',
    ),
    field('Note', h('textarea', { name: 'note', maxlength: 1000 }, user.note ?? '')),
    h('div', { class: 'row' },
      checkbox('is_admin', 'Administrator (can use this console)', user.is_admin),
      editing ? checkbox('status', 'Account active', user.status === 1) : null,
    ),
  ];
}

function readForm(form, editing) {
  const e = form.elements;
  const body = {
    username: e.username.value.trim(),
    display_name: e.display_name.value.trim(),
    email: e.email.value.trim(),
    note: e.note.value,
    is_admin: e.is_admin.checked,
  };
  if (e.password.value || !editing) body.password = e.password.value;
  if (editing) body.status = e.status.checked ? 1 : 0;
  return body;
}

function createUser(reload) {
  formModal({
    title: 'New user',
    submitLabel: 'Create user',
    fields: userForm(),
    async onSubmit(form) {
      const { user } = await api.post('/users', readForm(form, false));
      toast(`Created ${user.username}`);
      reload();
    },
  });
}

function editUser(user, reload) {
  formModal({
    title: `Edit ${user.username}`,
    fields: userForm(user),
    async onSubmit(form) {
      await api.patch(`/users/${user.id}`, readForm(form, true));
      toast('User updated');
      reload();
    },
  });
}

async function deleteUser(user, reload) {
  const ok = await confirmDialog(
    `Delete ${user.username}? Their address book and sessions are deleted and their devices become unassigned. This cannot be undone.`,
    { title: 'Delete user', confirmLabel: 'Delete user' },
  );
  if (!ok) return;
  await api.del(`/users/${user.id}`);
  toast(`Deleted ${user.username}`);
  reload();
}

async function showSessions(user, reload) {
  const body = h('div');
  const render = async () => {
    const { items } = await api.get(`/users/${user.id}/sessions`);
    body.replaceChildren(h('div', { class: 'card' }, dataTable({
      rows: items,
      empty: 'No active sessions.',
      columns: [
        { label: 'Type', render: (s) => badge(s.kind === 'web' ? 'Web console' : 'RustDesk client', s.kind === 'web' ? 'accent' : '') },
        {
          label: 'Device',
          render: (s) => s.kind === 'web'
            ? h('span', { class: 'sub', title: s.user_agent }, s.current ? 'This browser' : (s.user_agent.split(' ')[0] || 'Browser'))
            : h('div', null, h('span', { class: 'mono' }, s.device_id || '—'), s.device_info?.name ? h('div', { class: 'sub' }, `${s.device_info.name}${s.device_info.os ? ` · ${s.device_info.os}` : ''}`) : null),
        },
        { label: 'IP', render: (s) => h('span', { class: 'mono' }, s.ip || '—') },
        { label: 'Signed in', render: (s) => when(s.created_at) },
        { label: 'Last used', render: (s) => when(s.last_used_at) },
        {
          label: '',
          class: 'actions',
          render: (s) => s.current ? null : h('button', {
            type: 'button',
            class: 'btn sm danger',
            onclick: async () => {
              await api.del(`/sessions/${s.id}`);
              toast('Session revoked');
              render();
              reload();
            },
          }, 'Revoke'),
        },
      ],
    })));
  };
  await render();
  modal({ title: `Sessions for ${user.username}`, wide: true, body });
}

export default {
  title: 'Users',
  async render({ root, session }) {
    let list;
    const reload = () => list.reload();
    root.append(pageHeader('Users', 'Accounts that can sign in from RustDesk clients. Administrators can also use this console.', [
      h('button', { type: 'button', class: 'btn primary', onclick: () => createUser(reload) }, icon('plus'), 'New user'),
    ]));
    list = listView({
      endpoint: '/users',
      searchPlaceholder: 'Search users…',
      empty: 'No users.',
      onRowClick: (u) => editUser(u, reload),
      columns: [
        {
          label: 'User',
          render: (u) => h('div', null,
            h('div', { class: 'primary-cell' }, u.username, u.id === session.user.id ? h('span', { class: 'muted' }, ' (you)') : null),
            h('div', { class: 'sub' }, [u.display_name, u.email].filter(Boolean).join(' · ') || '—'),
          ),
        },
        { label: 'Role', render: (u) => (u.is_admin ? badge('Admin', 'accent') : badge('User')) },
        { label: 'Status', render: (u) => (u.status === 1 ? badge('Active', 'success') : badge('Disabled', 'danger')) },
        { label: 'Devices', class: 'hide-sm', render: (u) => (u.device_count ? h('a', { href: `#/devices?owner=${u.id}` }, String(u.device_count)) : '0') },
        { label: 'Sessions', class: 'hide-sm', render: (u) => String(u.session_count) },
        { label: 'Last sign-in', class: 'hide-sm', render: (u) => when(u.last_login_at) },
        {
          label: '',
          class: 'actions',
          render: (u) => [
            h('a', { class: 'icon-btn', href: `#/address-books/${enc(u.id)}`, title: 'Address book', 'aria-label': `Address book of ${u.username}` }, icon('book')),
            h('button', { type: 'button', class: 'icon-btn', title: 'Sessions', 'aria-label': `Sessions of ${u.username}`, onclick: () => showSessions(u, reload) }, icon('key')),
            h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${u.username}`, onclick: () => editUser(u, reload) }, icon('edit')),
            u.id === session.user.id ? null : h('button', { type: 'button', class: 'icon-btn danger', title: 'Delete', 'aria-label': `Delete ${u.username}`, onclick: () => deleteUser(u, reload) }, icon('trash')),
          ],
        },
      ],
    });
    root.append(list.el);
  },
};
