import { api } from '../lib/api.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { field, fmtDate, input, pageHeader, toast } from '../lib/ui.js';

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
    ));
  },
};
