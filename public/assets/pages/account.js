import { api } from '../lib/api.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { badge, confirmDialog, dataTable, errorBox, field, fmtDate, input, pageHeader, timeAgo, toast } from '../lib/ui.js';

function cloudflareCard(session) {
  const body = h('div', { class: 'card-body stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const card = h('div', { class: 'card' }, h('div', { class: 'card-header' }, icon('cloud'), h('h2', null, 'Cloudflare Access')), body);
  const viaCloudflare = session.auth_method === 'cloudflare';

  function draw(cf) {
    const parts = [];
    if (!cf.enabled) {
      parts.push(h('p', { class: 'muted' }, 'Cloudflare Access sign-in is not enabled. An administrator can set it up under Settings → Cloudflare Zero Trust.'));
    }
    if (cf.linked_email) {
      parts.push(h('dl', { class: 'kv' },
        h('dt', null, 'Linked identity'), h('dd', null, cf.linked_email),
        h('dt', null, 'Linked'), h('dd', null, fmtDate(cf.linked_at)),
        h('dt', null, 'This session'), h('dd', null, viaCloudflare ? 'Signed in with Cloudflare Access' : 'Signed in with password'),
      ));
    }
    if (cf.enabled) {
      if (cf.error) parts.push(h('p', null, badge('Token rejected', 'danger'), ' ', cf.error));
      else if (!cf.identity) parts.push(h('p', { class: 'muted' }, 'This page was not opened through the console\'s Cloudflare Access application, so there is no identity to link.'));
      else if (cf.identity.email !== cf.linked_email) {
        parts.push(h('p', null, `You are signed in to Cloudflare Access as `, h('strong', null, cf.identity.email), '.'));
      }
      if (!cf.linked_email || cf.identity?.email === cf.linked_email) {
        parts.push(h('p', { class: 'muted small' }, cf.auto_login
          ? 'Once linked, opening the console through Cloudflare Access signs you in automatically.'
          : 'Once linked, the sign-in page offers to continue with your Cloudflare Access identity.'));
      }
    }
    const actions = h('div', { class: 'row' });
    if (cf.enabled && cf.identity && cf.identity.email !== cf.linked_email) {
      actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        draw(await api.post('/me/cloudflare'));
        toast(`Linked ${cf.identity.email}`);
      } }, icon('link'), cf.linked_email ? `Link ${cf.identity.email} instead` : `Link ${cf.identity.email}`));
    }
    if (cf.linked_email) {
      actions.append(h('button', {
        type: 'button', class: 'btn danger', disabled: viaCloudflare,
        title: viaCloudflare ? 'Sign in with your password to unlink' : null,
        onclick: async () => {
          if (!(await confirmDialog(`Unlink ${cf.linked_email}? You will no longer be signed in with Cloudflare Access.`, { confirmLabel: 'Unlink' }))) return;
          draw(await api.del('/me/cloudflare'));
          toast('Cloudflare Access unlinked');
        },
      }, 'Unlink'));
      if (viaCloudflare) actions.append(h('span', { class: 'muted small' }, 'Sign in with your password to unlink.'));
    }
    if (actions.childNodes.length) parts.push(actions);
    body.replaceChildren(...parts);
  }

  api.get('/me/cloudflare').then(draw, (err) => body.replaceChildren(errorBox(err)));
  return card;
}

function savedPasswordsCard() {
  const body = h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Loading…'));
  const card = h('div', { class: 'card' }, h('div', { class: 'card-header' }, icon('key'), h('h2', null, 'Saved device passwords')), body);
  const load = () => api.get('/remote/passwords').then(({ items }) => {
    if (!items.length) {
      body.replaceChildren(h('p', { class: 'muted' }, 'None. Passwords you choose to remember when connecting to a device appear here.'));
      return;
    }
    body.replaceChildren(dataTable({
      columns: [
        { label: 'Device', render: (p) => h('a', { href: `#/connect/${encodeURIComponent(p.peer_id)}`, title: 'Connect' }, p.hostname ? `${p.hostname} · ${p.peer_id}` : p.peer_id) },
        { label: 'Last used', render: (p) => timeAgo(p.last_used_at) },
        { label: '', render: (p) => h('button', { type: 'button', class: 'btn sm', onclick: async () => {
          await api.del(`/remote/passwords/${encodeURIComponent(p.peer_id)}`);
          toast('Saved password forgotten');
          load();
        } }, 'Forget') },
      ],
      rows: items,
    }));
  }, (err) => body.replaceChildren(errorBox(err)));
  load();
  return card;
}

export default {
  title: 'My account',
  render({ root, session }) {
    const u = session.user;
    root.append(pageHeader('My account', `Signed in as ${u.username}.`));

    const error = h('div', { class: 'form-error hidden', role: 'alert' });
    const form = h('form', { class: 'form card-body' },
      error,
      field('Current password', input('current_password', { type: 'password', autocomplete: 'current-password', required: true })),
      h('div', { class: 'form-grid' },
        field('New password', input('new_password', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true }), 'At least 8 characters.'),
        field('Confirm new password', input('confirm', { type: 'password', autocomplete: 'new-password', required: true })),
      ),
      h('div', null, h('button', { type: 'submit', class: 'btn primary' }, 'Change password')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const el = form.elements;
      error.classList.add('hidden');
      try {
        if (el.new_password.value !== el.confirm.value) throw new Error('The new passwords do not match');
        await api.post('/me/password', { current_password: el.current_password.value, new_password: el.new_password.value });
        form.reset();
        toast('Password changed. Other sessions were signed out.');
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      }
    });

    root.append(h('div', { class: 'grid-2' },
      h('div', { class: 'card' },
        h('div', { class: 'card-header' }, icon('user'), h('h2', null, 'Profile')),
        h('div', { class: 'card-body' }, h('dl', { class: 'kv' },
          h('dt', null, 'Username'), h('dd', null, u.username),
          h('dt', null, 'Display name'), h('dd', null, u.display_name || '—'),
          h('dt', null, 'Email'), h('dd', null, u.email || '—'),
          h('dt', null, 'Member since'), h('dd', null, fmtDate(u.created_at)),
        )),
      ),
      h('div', { class: 'card' }, h('div', { class: 'card-header' }, icon('lock'), h('h2', null, 'Change password')), form),
      cloudflareCard(session),
      savedPasswordsCard(),
    ));
  },
};
