import { api } from './api.js';
import { clear, debounce, h } from './dom.js';
import { icon } from './icons.js';

// ---------- Formatting ----------
export function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.round(hrs / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function when(ts) {
  if (!ts) return h('span', { class: 'muted' }, 'never');
  return h('time', { datetime: new Date(ts).toISOString(), title: fmtDate(ts), class: 'nowrap' }, timeAgo(ts));
}

export function duration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function badge(text, variant = '') {
  return h('span', { class: ['badge', variant] }, text);
}

/** RustDesk stores tag colours as signed/unsigned ARGB integers. */
export function argbToHex(value) {
  if (!Number.isFinite(value)) return '#7a869a';
  return `#${((value >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function hexToArgb(hex) {
  return (0xff000000 | Number.parseInt(hex.replace('#', ''), 16)) >>> 0;
}

export function osLabel(os) {
  if (!os) return '';
  // Clients report e.g. "windows / Windows 11 Pro" or "linux / Ubuntu 24.04".
  const [, detail] = os.split(' / ');
  return detail || os;
}

// ---------- Feedback ----------
export function toast(message, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const el = h('div', { class: ['toast', kind] }, message);
  host.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, kind === 'error' ? 6000 : 3500);
}

export function errorBox(err) {
  return h('div', { class: 'callout danger' }, icon('alert'), h('div', null, h('strong', null, 'Something went wrong'), h('p', null, err?.message ?? String(err))));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed — select the text and copy manually', 'error');
  }
}

export function copyField(value, { label = 'Copy' } = {}) {
  const input = h('input', { type: 'text', value, readOnly: true, onfocus: (e) => e.target.select() });
  return h('div', { class: 'copy-field' }, input, h('button', { type: 'button', class: 'btn', onclick: () => copyText(value), title: label }, icon('copy'), label));
}

// ---------- Dialogs ----------
export function modal({ title, body, footer, wide = false, onClose }) {
  const dlg = h('dialog', { class: ['modal', wide && 'wide'] });
  dlg.append(
    h('div', { class: 'modal-header' }, h('h2', null, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-footer' }, footer) : null,
  );
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close: () => dlg.close() };
}

/**
 * A modal containing a form. `onSubmit(form)` may throw to show an error;
 * resolving closes the dialog.
 */
export function formModal({ title, fields, submitLabel = 'Save', danger = false, wide = false, onSubmit }) {
  const error = h('div', { class: 'form-error hidden', role: 'alert' });
  const submit = h('button', { type: 'submit', class: ['btn', danger ? 'danger solid' : 'primary'] }, submitLabel);
  const form = h('form', { class: 'form', novalidate: true }, error, fields);
  const dlg = h('dialog', { class: ['modal', wide && 'wide'] });
  // The dialog body holds the real form; the footer submit button targets it via the `form` attribute.
  // Note: never read `form.id` — a field named "id" shadows it on HTMLFormElement.
  const formId = `f${Math.random().toString(36).slice(2)}`;
  form.setAttribute('id', formId);
  submit.setAttribute('form', formId);
  dlg.append(
    h('div', { class: 'modal-header' }, h('h2', null, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    h('div', { class: 'modal-body' }, form),
    h('div', { class: 'modal-footer' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), submit),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.classList.add('hidden');
    try {
      await onSubmit(form);
      dlg.close();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    } finally {
      submit.disabled = false;
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  form.querySelector('input:not([type=hidden]):not([readonly]), select, textarea')?.focus();
  return { el: dlg, form, close: () => dlg.close() };
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { type: 'button', class: ['btn', danger ? 'danger solid' : 'primary'], onclick: () => { result = true; m.close(); } }, confirmLabel);
    const m = modal({
      title,
      body: h('p', { class: 'muted' }, message),
      footer: [h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'Cancel'), ok],
      onClose: () => resolve(result),
    });
    ok.focus();
  });
}

// ---------- Form controls ----------
export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function input(name, attrs = {}) {
  return h('input', { name, type: 'text', autocomplete: 'off', ...attrs });
}

export function checkbox(name, label, checked = false, attrs = {}) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked, ...attrs }), h('span', null, label));
}

export function select(name, options, value, attrs = {}) {
  return h('select', { name, ...attrs }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));
}

// ---------- Page building blocks ----------
export function pageHeader(title, subtitle, actions = []) {
  return h('div', { class: 'page-header' },
    h('div', null, h('h1', null, title), subtitle ? h('p', null, subtitle) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

export function dataTable({ columns, rows, empty = 'Nothing to show yet.', onRowClick }) {
  const head = h('tr', null, columns.map((c) => h('th', { class: c.class }, c.label)));
  const body = rows.length
    ? rows.map((row) =>
        h('tr', {
          class: onRowClick && 'clickable',
          onclick: onRowClick && ((e) => {
            if (!e.target.closest('button, a, input, select, label')) onRowClick(row);
          }),
        }, columns.map((c) => h('td', { class: c.class }, c.render ? c.render(row) : (row[c.key] ?? '—')))),
      )
    : h('tr', null, h('td', { class: 'empty', colspan: columns.length }, empty));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, head), h('tbody', null, body)));
}

/**
 * Searchable, paginated table backed by an admin list endpoint returning
 * `{ items, total, page, pageSize }`.
 */
export function listView({ endpoint, columns, searchPlaceholder = 'Search…', filters = [], toolbar = [], empty, onRowClick, pageSize = 25, initial = {} }) {
  const state = { q: initial.q ?? '', page: 1, filters: { ...initial.filters } };
  const body = h('div', { class: 'list-body' });
  const pager = h('div', { class: 'pager' });
  let seq = 0;

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: searchPlaceholder,
    value: state.q,
    'aria-label': 'Search',
    oninput: debounce(() => {
      state.q = search.value.trim();
      state.page = 1;
      load();
    }, 250),
  });

  const filterEls = filters.map((f) => {
    const el = select(f.name, f.options, state.filters[f.name] ?? '', { 'aria-label': f.label });
    el.addEventListener('change', () => {
      state.filters[f.name] = el.value;
      state.page = 1;
      load();
    });
    return el;
  });

  async function load() {
    const id = ++seq;
    const params = new URLSearchParams({ page: state.page, pageSize });
    if (state.q) params.set('q', state.q);
    for (const [k, v] of Object.entries(state.filters)) if (v) params.set(k, v);
    body.classList.add('loading');
    try {
      const data = await api.get(`${endpoint}?${params}`);
      if (id !== seq) return;
      clear(body).append(dataTable({ columns, rows: data.items, empty: state.q ? 'No matches.' : empty, onRowClick }));
      renderPager(data);
    } catch (err) {
      if (id !== seq) return;
      clear(body).append(h('div', { class: 'card-body' }, errorBox(err)));
      clear(pager);
    } finally {
      if (id === seq) body.classList.remove('loading');
    }
  }

  function renderPager({ total, page, pageSize: size }) {
    clear(pager);
    if (!total) return;
    const pages = Math.max(1, Math.ceil(total / size));
    const from = (page - 1) * size + 1;
    const to = Math.min(total, page * size);
    const go = (p) => () => {
      state.page = p;
      load();
    };
    pager.append(
      h('span', null, `${from}–${to} of ${total}`),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn sm', disabled: page <= 1, onclick: go(page - 1) }, 'Previous'),
      h('span', null, `Page ${page} of ${pages}`),
      h('button', { type: 'button', class: 'btn sm', disabled: page >= pages, onclick: go(page + 1) }, 'Next'),
    );
  }

  const refresh = h('button', { type: 'button', class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => load() }, icon('refresh'));
  const el = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, search, filterEls, h('span', { class: 'spacer' }), toolbar, refresh), body, pager);
  load();
  return { el, reload: load };
}
