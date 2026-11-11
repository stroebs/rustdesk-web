import { h } from '../lib/dom.js';
import { listView, pageHeader } from '../lib/ui.js';
import { connectionColumns } from './common.js';

export default {
  title: 'Connections',
  render({ root, query }) {
    const device = query.get('device') ?? '';
    root.append(pageHeader('Connections', device
      ? h('span', null, 'Sessions to ', h('span', { class: 'mono' }, device), ' · ', h('a', { href: '#/connections' }, 'show all'))
      : 'Incoming remote sessions reported by controlled devices.'));
    const list = listView({
      endpoint: '/audit/connections',
      searchPlaceholder: 'Search device, peer, name, IP…',
      initial: { filters: { device } },
      empty: 'No connections recorded yet.',
      columns: connectionColumns,
    });
    root.append(list.el);
  },
};
