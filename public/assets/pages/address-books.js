import { api, enc } from '../lib/api.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { argbToHex, checkbox, confirmDialog, dataTable, field, formModal, hexToArgb, input, pageHeader, select, toast, when } from '../lib/ui.js';

const PLATFORMS = [['', '—'], ['Windows', 'Windows'], ['Mac OS', 'macOS'], ['Linux', 'Linux'], ['Android', 'Android']];

function tagChip(name, colors, onRemove) {
  return h('span', { class: 'tag' },
    h('span', { class: 'swatch', dataset: { color: argbToHex(colors[name]) } }),
    name,
    onRemove ? h('button', { type: 'button', class: 'icon-btn', title: `Delete tag ${name}`, 'aria-label': `Delete tag ${name}`, onclick: onRemove }, icon('x')) : null,
  );
}

// Swatch colours are applied via CSSOM, which the CSP allows (inline style attributes are not).
function paintSwatches(el) {
  for (const s of el.querySelectorAll('.swatch[data-color]')) s.style.background = s.dataset.color;
  return el;
}

async function renderIndex(root) {
  root.append(pageHeader('Address books', 'Each user has a personal address book that syncs to every RustDesk client they sign in on.'));
  const { items } = await api.get('/address-books');
  root.append(h('div', { class: 'card' }, dataTable({
    rows: items,
    empty: 'No users yet.',
    onRowClick: (r) => { location.hash = `#/address-books/${r.user_id}`; },
    columns: [
      { label: 'User', render: (r) => h('div', null, h('div', { class: 'primary-cell' }, r.username), r.display_name ? h('div', { class: 'sub' }, r.display_name) : null) },
      { label: 'Peers', render: (r) => String(r.peers) },
      { label: 'Tags', render: (r) => String(r.tags) },
      { label: 'Last updated', render: (r) => when(r.updated_at) },
      { label: '', class: 'actions', render: (r) => h('a', { class: 'btn sm', href: `#/address-books/${r.user_id}` }, 'Open') },
    ],
  })));
}

async function renderBook(root, userId) {
  let state = await api.get(`/address-books/${enc(userId)}`);
  const content = h('div', { class: 'stack' });
  const name = state.user.display_name || state.user.username;

  root.append(pageHeader(`${name}'s address book`, 'Changes sync to the user’s RustDesk clients the next time they refresh their address book.', [
    h('a', { class: 'btn', href: '#/address-books' }, 'All address books'),
    h('button', { type: 'button', class: 'btn primary', onclick: () => editPeer() }, icon('plus'), 'Add peer'),
  ]), content);

  async function save(next, message) {
    await api.put(`/address-books/${enc(userId)}`, { tags: next.tags, tag_colors: next.tag_colors, peers: next.peers });
    state = await api.get(`/address-books/${enc(userId)}`);
    toast(message);
    draw();
  }

  function editPeer(peer) {
    const editing = Boolean(peer);
    peer ??= { id: '', alias: '', hostname: '', username: '', platform: '', tags: [] };
    formModal({
      title: editing ? `Edit ${peer.alias || peer.id}` : 'Add peer',
      submitLabel: editing ? 'Save' : 'Add peer',
      fields: [
        h('div', { class: 'form-grid' },
          field('RustDesk ID', input('id', { value: peer.id, required: true, readOnly: editing, maxlength: 100, class: 'mono' })),
          field('Alias', input('alias', { value: peer.alias ?? '', maxlength: 255 })),
          field('Hostname', input('hostname', { value: peer.hostname ?? '', maxlength: 255 })),
          field('Username', input('username', { value: peer.username ?? '', maxlength: 255 })),
        ),
        field('Platform', select('platform', PLATFORMS, peer.platform ?? '')),
        state.tags.length
          ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Tags'), h('div', { class: 'row' }, state.tags.map((t) => checkbox('tags', t, peer.tags.includes(t), { value: t }))))
          : h('p', { class: 'muted small' }, 'Create tags below the peer list to group peers.'),
      ],
      async onSubmit(form) {
        const e = form.elements;
        const id = e.id.value.trim();
        if (!id) throw new Error('RustDesk ID is required');
        if (!editing && state.peers.some((p) => p.id === id)) throw new Error('That ID is already in the address book');
        const updated = {
          ...peer,
          id,
          alias: e.alias.value.trim(),
          hostname: e.hostname.value.trim(),
          username: e.username.value.trim(),
          platform: e.platform.value,
          tags: [...form.querySelectorAll('input[name=tags]:checked')].map((c) => c.value),
        };
        const peers = editing ? state.peers.map((p) => (p.id === peer.id ? updated : p)) : [...state.peers, updated];
        await save({ ...state, peers }, editing ? 'Peer updated' : 'Peer added');
      },
    });
  }

  async function removePeer(peer) {
    if (!(await confirmDialog(`Remove ${peer.alias || peer.id} from this address book?`, { title: 'Remove peer', confirmLabel: 'Remove' }))) return;
    await save({ ...state, peers: state.peers.filter((p) => p.id !== peer.id) }, 'Peer removed');
  }

  async function removeTag(tag) {
    if (!(await confirmDialog(`Delete the tag “${tag}”? It is removed from all peers.`, { title: 'Delete tag', confirmLabel: 'Delete tag' }))) return;
    const tagColors = { ...state.tag_colors };
    delete tagColors[tag];
    await save({
      tags: state.tags.filter((t) => t !== tag),
      tag_colors: tagColors,
      peers: state.peers.map((p) => ({ ...p, tags: p.tags.filter((t) => t !== tag) })),
    }, 'Tag deleted');
  }

  function tagForm() {
    const name = input('tag', { placeholder: 'New tag', maxlength: 100, 'aria-label': 'New tag name' });
    const color = h('input', { type: 'color', name: 'color', value: '#2f5bd3', 'aria-label': 'Tag colour' });
    const form = h('form', { class: 'row tag-form' }, name, color, h('button', { type: 'submit', class: 'btn' }, icon('plus'), 'Add tag'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const tag = name.value.trim();
      if (!tag) return;
      if (state.tags.includes(tag)) return toast('That tag already exists', 'error');
      await save({ ...state, tags: [...state.tags, tag], tag_colors: { ...state.tag_colors, [tag]: hexToArgb(color.value) } }, 'Tag added');
    });
    return form;
  }

  function draw() {
    content.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h2', null, `Peers (${state.peers.length})`), h('span', { class: 'spacer' }), state.updated_at ? h('span', { class: 'muted small' }, 'Updated ', when(state.updated_at)) : null),
        dataTable({
          rows: state.peers,
          empty: 'This address book is empty.',
          onRowClick: editPeer,
          columns: [
            { label: 'ID', render: (p) => h('span', { class: 'mono primary-cell' }, p.id) },
            { label: 'Alias', render: (p) => p.alias || h('span', { class: 'muted' }, '—') },
            { label: 'Hostname', class: 'hide-sm', render: (p) => p.hostname || '—' },
            { label: 'Platform', class: 'hide-sm', render: (p) => p.platform || '—' },
            { label: 'Tags', render: (p) => p.tags.map((t) => tagChip(t, state.tag_colors)) },
            {
              label: '',
              class: 'actions',
              render: (p) => [
                h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${p.id}`, onclick: () => editPeer(p) }, icon('edit')),
                h('button', { type: 'button', class: 'icon-btn danger', title: 'Remove', 'aria-label': `Remove ${p.id}`, onclick: () => removePeer(p) }, icon('trash')),
              ],
            },
          ],
        }),
      ),
      h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h2', null, 'Tags')),
        h('div', { class: 'card-body stack' },
          state.tags.length ? h('div', null, state.tags.map((t) => tagChip(t, state.tag_colors, () => removeTag(t)))) : h('p', { class: 'muted' }, 'No tags yet.'),
          tagForm(),
        ),
      ),
    );
    paintSwatches(content);
  }

  draw();
}

export default {
  title: 'Address books',
  render({ root, params }) {
    return params[0] ? renderBook(root, params[0]) : renderIndex(root);
  },
};
