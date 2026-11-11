import { api } from '../lib/api.js';
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { badge, copyField, field, input, pageHeader, select, timeAgo, toast } from '../lib/ui.js';

const KEY_SOURCES = {
  settings: 'Saved in Settings.',
  env: 'From the SERVER_KEY environment variable. Saving a value here overrides it.',
  file: 'Read from the hbbs public key file (HBBS_KEY_FILE). Saving a value here overrides it.',
  '': 'The contents of id_ed25519.pub in your hbbs data directory.',
};

const ENV = {
  enabled: 'CF_ACCESS_ENABLED',
  team_domain: 'CF_ACCESS_TEAM_DOMAIN',
  audience: 'CF_ACCESS_AUD',
  auto_login: 'CF_ACCESS_AUTO_LOGIN',
  client_ip: 'CF_CLIENT_IP',
  trusted_proxies: 'CF_TRUSTED_PROXIES',
};

/** Where an effective value came from, for the field hint. */
function source(cf, name, value) {
  const from = cf.sources[name];
  const shown = typeof value === 'boolean' ? (value ? 'on' : 'off') : value;
  if (from === 'settings') return `Saved here (${ENV[name]} is ignored).`;
  if (name === 'enabled' && !from) return value ? 'Not set: on, because the team domain and AUD tag come from the environment.' : 'Not set: off (CF_ACCESS_ENABLED).';
  if (from === 'env') return `Currently ${shown ? `"${shown}"` : 'empty'}, from ${ENV[name]}.`;
  return `Not set: ${typeof value === 'boolean' ? `${shown} by default` : 'empty'} (${ENV[name]}).`;
}

const toggle = (name, value) => select(name, [['', 'Use environment / default'], ['1', 'On'], ['0', 'Off']], value);

function cloudflareCard(s, onSaved) {
  const cf = s.cloudflare;
  const form = h('form', { class: 'form card-body' },
    h('p', { class: 'muted' },
      'Put the console behind a Cloudflare Access application, then let administrators link their Access identity under My account to be signed in with it. ',
      'Every request is checked against the team\'s signing keys, the issuer and the application audience.'),
    h('div', { class: 'form-grid' },
      field('Access sign-in', toggle('enabled', cf.saved.enabled), source(cf, 'enabled', cf.enabled)),
      field('Automatic sign-in', toggle('auto_login', cf.saved.auto_login), `${source(cf, 'auto_login', cf.auto_login)} Off: the sign-in page offers a button instead.`),
    ),
    field('Team domain', input('team_domain', { value: cf.saved.team_domain, placeholder: cf.team_domain || 'myteam.cloudflareaccess.com', spellcheck: 'false' }),
      `Zero Trust → Settings → Custom pages shows it. ${source(cf, 'team_domain', cf.sources.team_domain === 'env' ? cf.team_domain : '')}`),
    field('Application Audience (AUD) tag', input('audience', { value: cf.saved.audience, placeholder: cf.audiences.join(', ') || '64 hexadecimal characters', class: 'mono', spellcheck: 'false' }),
      `Access → Applications → this application → Overview. Separate several with commas. ${source(cf, 'audience', cf.sources.audience === 'env' ? cf.audiences.join(', ') : '')}`),
    h('div', { class: 'form-grid' },
      field('Client IP from CF-Connecting-IP', toggle('client_ip', cf.saved.client_ip),
        `${source(cf, 'client_ip', cf.client_ip)} Only turn on if Cloudflare is the only way to reach this port: anyone else could forge the header.`),
      field('Trusted proxies', input('trusted_proxies', { value: cf.saved.trusted_proxies, placeholder: cf.trusted_proxies || 'Any (e.g. 10.0.0.5, 172.16.0.0/12)', spellcheck: 'false' }),
        `Addresses of cloudflared or the proxy in front of the console. The header is only believed from these. ${source(cf, 'trusted_proxies', cf.sources.trusted_proxies === 'env' ? cf.trusted_proxies : '')}`),
    ),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save'), h('span', { class: 'muted small' }, 'Empty fields fall back to environment variables.')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const el = form.elements;
    const saved = await api.put('/settings', { cloudflare: {
      enabled: el.enabled.value,
      auto_login: el.auto_login.value,
      team_domain: el.team_domain.value,
      audience: el.audience.value,
      client_ip: el.client_ip.value,
      trusted_proxies: el.trusted_proxies.value,
    } });
    toast('Cloudflare settings saved');
    onSaved(saved);
  });

  const status = h('div', { class: 'card-body' }, h('dl', { class: 'kv' },
    h('dt', null, 'Access sign-in'), h('dd', null, cf.ready ? badge('Active', 'success') : cf.enabled ? badge('Incomplete', 'warn') : badge('Off')),
    h('dt', null, 'Issuer'), h('dd', { class: 'mono' }, cf.issuer || '—'),
    h('dt', null, 'Signing keys'), h('dd', { class: 'mono' }, cf.certs_url || '—'),
    h('dt', null, 'Linked accounts'), h('dd', null, String(cf.linked_users)),
    h('dt', null, 'Client IP'), h('dd', null, cf.client_ip ? `CF-Connecting-IP${cf.trusted_proxies ? ` from ${cf.trusted_proxies}` : ' from any address'}` : 'Connection address' + (s.environment.trust_proxy ? ' / X-Forwarded-For' : '')),
  ), cf.problems.length ? h('div', { class: 'stack' }, cf.problems.map((p) => h('p', null, badge('Problem', 'danger'), ' ', p))) : null);

  return h('div', { class: 'card' }, h('div', { class: 'card-header' }, icon('cloud'), h('h2', null, 'Cloudflare Zero Trust')), form, status);
}

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
        cloudflareCard(s, (saved) => { s = saved; draw(); }),
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
