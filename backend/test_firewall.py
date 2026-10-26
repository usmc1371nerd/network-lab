import unittest
from app import app


class FirewallTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.pc = dict(id='pc', name='PC', type='pc', ip='10.10.10.10/24', x=0, y=0,
                       routes=[dict(network='10.10.30.0/24', via='10.10.10.1')])
        self.server = dict(id='server', name='Server', type='server', ip='10.10.30.10/24', x=0, y=0,
                           routes=[dict(network='10.10.10.0/24', via='10.10.30.1')])
        self.fw = dict(id='fw', name='Firewall', type='firewall', ip='10.10.10.1/24', firewallEnabled=True,
                       firewallVersion=1, interfaces=[
                           dict(id='lan', name='LAN', neighborId='pc', address='10.10.10.1/24', enabled=True),
                           dict(id='wan', name='WAN', neighborId='server', address='10.10.30.1/24', enabled=True),
                       ], rules=[], routes=[])
        self.links = [{'from': 'pc', 'to': 'fw'}, {'from': 'fw', 'to': 'server'}]

    def rule(self, action='pass', **fields):
        return dict(dict(id='r1', enabled=True, action=action, interfaceId='lan', protocol='ICMP',
                         source='interface-net', destination='any', description='LAN ping'), **fields)

    def ping(self, source='pc', target='server', **fields):
        response = self.client.post('/api/run-command', json=dict(command=f'ping {target}',
            devices=[self.pc, self.server, self.fw], connections=self.links, sourceDeviceId=source, **fields))
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def assert_received(self, result, count):
        self.assertIn(f'4 packets transmitted, {count} received', '\n'.join(result['output']))

    def test_default_deny_blocks_before_egress_and_reports_reason(self):
        result = self.ping()
        self.assert_received(result, 0)
        self.assertEqual(len(result['firewallLogs']), 4)
        self.assertTrue(all(l['action'] == 'block' and l['interface'] == 'LAN' for l in result['firewallLogs']))
        self.assertFalse(any(p.get('fromDeviceId') == 'fw' and p.get('toDeviceId') == 'server' for p in result['packets']))

    def test_pass_creates_reply_state_without_wan_allow_rule(self):
        self.fw['rules'] = [self.rule()]
        result = self.ping()
        self.assert_received(result, 4)
        self.assertEqual(sum(l['state'] for l in result['firewallLogs']), 4)
        self.assertTrue(all(l['action'] == 'pass' for l in result['firewallLogs']))

    def test_first_match_and_disabled_rules(self):
        self.fw['rules'] = [self.rule('block'), self.rule(id='r2')]
        self.assert_received(self.ping(), 0)
        self.fw['rules'][0]['enabled'] = False
        self.assert_received(self.ping(), 4)

    def test_source_and_destination_subnet_matching(self):
        self.fw['rules'] = [self.rule(source='10.10.10.0/24', destination='10.10.30.10')]
        self.assert_received(self.ping(), 4)
        self.fw['rules'][0]['destination'] = '10.10.20.0/24'
        self.assert_received(self.ping(), 0)

    def test_wrong_ingress_interface_does_not_match(self):
        self.fw['rules'] = [self.rule(interfaceId='wan')]
        self.assert_received(self.ping(), 0)

    def test_filter_off_keeps_configured_routing(self):
        self.fw['firewallEnabled'] = False
        result = self.ping()
        self.assert_received(result, 4)
        self.assertEqual(result['firewallLogs'], [])

    def test_missing_return_route_is_not_hidden_by_allow_rule(self):
        self.fw['rules'] = [self.rule()]
        self.server['routes'] = []
        result = self.ping()
        self.assert_received(result, 0)
        self.assertIn('no return route', '\n'.join(result['output']))

    def test_disabled_or_unassigned_egress_stops_routing(self):
        self.fw['rules'] = [self.rule()]
        self.fw['interfaces'][1]['enabled'] = False
        self.assert_received(self.ping(), 0)

    def test_gateway_address_must_be_on_the_source_cable(self):
        self.pc['routes'][0]['via'] = '10.10.30.1'
        result = self.ping()
        self.assert_received(result, 0)
        self.assertIn('gateway address is not assigned', '\n'.join(result['output']))

    def test_arp_stays_on_lan_and_resolves_gateway(self):
        self.fw['rules'] = [self.rule()]
        result = self.ping()
        arp = [p for p in result['packets'] if p['protocol'] == 'ARP']
        self.assertTrue(arp)
        self.assertTrue(all('server' not in [p.get('fromDeviceId'), p.get('toDeviceId')] for p in arp))
        update = next(u for u in result['deviceUpdates'] if u['id'] == 'pc')
        self.assertIn('10.10.10.1', update['arp_table'])
        self.assertNotIn('10.10.30.10', update['arp_table'])

    def test_interface_ip_can_be_pinged_as_firewall_target(self):
        self.fw['rules'] = [self.rule()]
        result = self.ping(target='10.10.10.1')
        self.assert_received(result, 4)
        self.assertIn('64 bytes from 10.10.10.1:', '\n'.join(result['output']))

    def test_state_does_not_allow_new_reverse_initiated_connection(self):
        self.fw['rules'] = [self.rule()]
        self.assert_received(self.ping(), 4)
        self.assert_received(self.ping(source='server', target='pc'), 0)

    def test_firewall_diagnostic_uses_assigned_source_and_state_for_reply(self):
        result = self.ping(source='fw', target='server', sourceAddress='10.10.30.1/24')
        self.assert_received(result, 4)
        icmp = [p for p in result['packets'] if p['protocol'] == 'ICMP']
        self.assertTrue(any(p['src'] == '10.10.30.1' for p in icmp))

    def test_switch_between_pc_and_lan_interface(self):
        switch = dict(id='switch', name='Switch', type='switch', ip='10.10.10.2')
        self.fw['interfaces'][0]['neighborId'] = 'switch'
        self.fw['rules'] = [self.rule()]
        links = [{'from': 'pc', 'to': 'switch'}, {'from': 'switch', 'to': 'fw'}, {'from': 'fw', 'to': 'server'}]
        response = self.client.post('/api/run-command', json=dict(command='ping server',
            devices=[self.pc, switch, self.fw, self.server], connections=links, sourceDeviceId='pc'))
        self.assertEqual(response.status_code, 200)
        self.assert_received(response.get_json(), 4)


if __name__ == '__main__':
    unittest.main()
