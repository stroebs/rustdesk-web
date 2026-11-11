import { api } from '../lib/api.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { copyField, field, input, pageHeader, timeAgo, toast } from '../lib/ui.js';

const KEY_SOURCES = {
  settings: 'Saved in Settings.',
  env: 'From the SERVER_KEY environment variable. Saving a value here overrides it.',
  file: 'Read from the hbbs public key file (HBBS_KEY_FILE). Saving a value here overrides it.',
  '': 'The contents of id_ed25519.pub in your hbbs data directory.',
};

export default {
  title: 'Settings',
  async render({ root }) {
    root.append(pageHeader('Settings', 'Server addresses and the public key that RustDesk clients need.'));
    const content = h('div', { class: 'stack' });
    root.append(content);
    let s = await api.get('/settings');

    function draw() {
      const form = h('form', { class: 'form card-body' },
        h('div', { class: 'form-grid' },
          field('ID server', input('id_server', { value: s.saved.id_server, placeholder: s.id_server || 'rustdesk.example.com' }), 'Host name or IP of hbbs, optionally with :port.'),
          field('Relay server', input('relay_server', { value: s.saved.relay_server, placeholder: s.relay_server || 'Optional, defaults to the ID server' }), 'Only needed if hbbr runs on a different host.'),
        ),
        field('API server', input('api_server', { value: s.saved.api_server, placeholder: s.api_server || location.origin }), `The URL clients use to reach this console, for example ${location.origin}.`),
        field('Public key', input('key', { value: s.saved.key, placeholder: s.key || 'Contents of id_ed25519.pub', class: 'mono' }), KEY_SOURCES[s.key_source]),
        h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save'), h('span', { class: 'muted small' }, 'Empty fields fall back to environment variables.')),
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const el = form.elements;
        s = await api.put('/settings', {
          id_server: el.id_server.value,
          relay_server: el.relay_server.value,
          api_server: el.api_server.value,
          key: el.key.value,
        });
        toast('Settings saved');
        draw();
      });

      const share = s.config_string
        ? h('div', { class: 'card-body stack' },
            field('Configuration string', copyField(s.config_string), 'In RustDesk open Settings → Network → ID/Relay server, then use the paste/import button.'),
            field('Windows installer name', copyField(s.installer_name), 'Rename the RustDesk installer to this to preconfigure it (the API server parameter needs RustDesk 1.2 or later).'),
            h('dl', { class: 'kv' },
              h('dt', null, 'ID server'), h('dd', { class: 'mono' }, s.id_server),
              h('dt', null, 'Relay server'), h('dd', { class: 'mono' }, s.relay_server || '(same as ID server)'),
              h('dt', null, 'API server'), h('dd', { class: 'mono' }, s.api_server || h('span', { class: 'muted' }, 'not set: sign-in, address books and audit logs will not work')),
              h('dt', null, 'Key'), h('dd', { class: 'mono' }, s.key || h('span', { class: 'muted' }, 'not set')),
            ),
          )
        : h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Set at least the ID server to generate a configuration string.'));

      const env = s.environment;
      const hbbs = s.hbbs;
      content.replaceChildren(
        h('div', { class: 'card' }, h('div', { class: 'card-header' }, icon('server'), h('h2', null, 'Client configuration')), form),
        h('div', { class: 'card' }, h('div', { class: 'card-header' }, icon('copy'), h('h2', null, 'Share with clients')), share),
        h('div', { class: 'card' },
          h('div', { class: 'card-header' }, icon('sliders'), h('h2', null, 'Server')),
          h('div', { class: 'card-body' }, h('dl', { class: 'kv' },
            h('dt', null, 'Version'), h('dd', null, s.version),
            h('dt', null, 'hbbs database'), h('dd', null,
              !env.hbbs_db ? 'Not configured (HBBS_DB_PATH)'
                : hbbs.error ? h('span', { class: 'badge danger' }, hbbs.error)
                : `${hbbs.peers} peers, synced ${timeAgo(hbbs.lastSync)}`),
            h('dt', null, 'hbbs key file'), h('dd', null, env.hbbs_key_file ? (s.key_source === 'file' ? 'In use' : 'Configured') : 'Not configured (HBBS_KEY_FILE)'),
            h('dt', null, 'Online threshold'), h('dd', null, `${env.online_threshold_seconds}s since last heartbeat`),
            h('dt', null, 'Client sign-in lifetime'), h('dd', null, `${env.client_token_ttl_days} days (sliding)`),
            h('dt', null, 'Console session lifetime'), h('dd', null, `${env.session_ttl_hours} hours (sliding)`),
            h('dt', null, 'Log retention'), h('dd', null, `${env.log_retention_days} days`),
            h('dt', null, 'Behind proxy'), h('dd', null, env.trust_proxy ? 'Yes (TRUST_PROXY)' : 'No'),
          )),
        ),
      );
    }
    draw();
  },
};
