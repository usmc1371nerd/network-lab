"""Run from the project root: .venv/bin/python -m unittest discover -s backend -v."""
import unittest
from unittest.mock import patch

from app import app, device_mac


def host(id, type='pc', ip=None, **fields):
    return dict(id=id, name=id, type=type, ip=ip or '', **fields)


def link(a, b, **fields):
    return dict({'from': a, 'to': b, 'direction': 'both', 'transport': 'cat'}, **fields)


class PingRegressionTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.pc = host('pc-1', ip='10.10.10.1')
        self.server = host('server', 'server', '10.10.10.100')

    def run_ping(self, devices, connections, source='pc-1', command='ping server'):
        response = self.client.post('/api/run-command', json=dict(
            command=command, devices=devices, connections=connections, sourceDeviceId=source))
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def assert_received(self, result, count):
        self.assertIn(f'4 packets transmitted, {count} received', '\n'.join(result['output']))
        replies = [line for line in result['output'] if line.startswith('64 bytes from')]
        self.assertEqual(len(replies), count)

    def test_issue_screenshot_pc_and_usb_storage_are_not_transit(self):
        devices = [self.pc, host('pc-2', ip='10.10.10.2'),
                   host('storage', 'usb-storage'), self.server]
        result = self.run_ping(devices, [link('pc-1', 'pc-2'), link('pc-2', 'server'),
            link('pc-1', 'storage', transport='usb'), link('storage', 'server', transport='usb')])
        self.assert_received(result, 0)
        self.assertFalse(any(p['protocol'] in {'ARP', 'ICMP'} for p in result['packets']))
        self.assertFalse(any(u.get('arp_table') for u in result['deviceUpdates']))

    def test_all_ordinary_hosts_and_peripherals_block_transit(self):
        for type in ['pc', 'laptop', 'server', 'phone', 'usb-storage', 'usb-keyboard', 'sensor']:
            with self.subTest(type=type):
                devices = [self.pc, host('middle', type, '10.10.10.2'), self.server]
                result = self.run_ping(devices, [link('pc-1', 'middle'), link('middle', 'server')])
                self.assert_received(result, 0)

    def test_direct_connection_and_physical_hop_metadata(self):
        result = self.run_ping([self.pc, self.server], [link('pc-1', 'server')])
        self.assert_received(result, 4)
        frames = [p for p in result['packets'] if p['protocol'] in {'ARP', 'ICMP'}]
        self.assertEqual(len(frames), 10)
        self.assertTrue(all(p['simulationApplied'] and p['status'] == 'delivered' for p in frames))
        self.assertTrue(all({p['fromDeviceId'], p['toDeviceId']} == {'pc-1', 'server'} for p in frames))

    def test_switch_hub_and_ap_paths_succeed(self):
        for type in ['switch', 'hub', 'ap']:
            with self.subTest(type=type):
                devices = [self.pc, host('middle', type), self.server]
                result = self.run_ping(devices, [link('pc-1', 'middle'), link('middle', 'server')])
                self.assert_received(result, 4)
                self.assertTrue(all(p.get('status') != 'dropped' for p in result['packets']))
                for packet in result['packets']:
                    if packet['protocol'] == 'ICMP':
                        self.assertIn('middle', [packet['fromDeviceId'], packet['toDeviceId']])
                        self.assertIn(packet['src'], ['10.10.10.1', '10.10.10.100'])

    def test_disconnected_topology(self):
        self.assert_received(self.run_ping([self.pc, self.server], []), 0)

    def test_usb_link_between_hosts_is_not_an_ip_network(self):
        result = self.run_ping([self.pc, self.server], [link('pc-1', 'server', transport='usb')])
        self.assert_received(result, 0)

    def test_arp_block_or_loss_does_not_create_replies_or_cache(self):
        for conditions in [{'blocked': True}, {'lossPct': 100}]:
            with self.subTest(conditions=conditions):
                result = self.run_ping([self.pc, self.server], [link('pc-1', 'server', conditions=conditions)])
                self.assert_received(result, 0)
                self.assertEqual(len([p for p in result['packets'] if p.get('status') == 'dropped']), 1)
                self.assertFalse(any(p['protocol'] == 'ICMP' for p in result['packets']))
                self.assertFalse(any(u.get('arp_table') for u in result['deviceUpdates']))

    def test_one_way_link_cannot_deliver_arp_reply(self):
        result = self.run_ping([self.pc, self.server], [link('pc-1', 'server', direction='forward')])
        self.assert_received(result, 0)
        self.assertTrue(any(p.get('dropReason') == 'direction-block' for p in result['packets']))
        self.assertFalse(any(u['id'] == 'pc-1' and u.get('arp_table') for u in result['deviceUpdates']))

    def test_cached_arp_does_not_bypass_blocked_or_one_way_link(self):
        self.pc['arp_table'] = {'10.10.10.100': device_mac(self.server)}
        for fields in [{'direction': 'forward'}, {'conditions': {'blocked': True}}, {'conditions': {'lossPct': 100}}]:
            with self.subTest(fields=fields):
                result = self.run_ping([self.pc, self.server], [link('pc-1', 'server', **fields)])
                self.assert_received(result, 0)
                self.assertEqual(sum(p.get('status') == 'dropped' for p in result['packets']), 4)

    def test_drop_at_first_hop_stops_later_hops_and_replies(self):
        self.pc['arp_table'] = {'10.10.10.100': device_mac(self.server)}
        devices = [self.pc, host('switch', 'switch'), self.server]
        result = self.run_ping(devices, [link('pc-1', 'switch', conditions={'lossPct': 100}), link('switch', 'server')])
        self.assert_received(result, 0)
        frames = [p for p in result['packets'] if p['protocol'] == 'ICMP']
        self.assertEqual(len(frames), 4)
        self.assertTrue(all(p['fromDeviceId'] == 'pc-1' and p['status'] == 'dropped' for p in frames))

    def test_partial_loss_statistics_match_delivered_replies(self):
        self.pc['arp_table'] = {'10.10.10.100': device_mac(self.server)}
        # Sequence 1 request fails; 2 succeeds; 3 reply fails; 4 succeeds.
        with patch('link_simulation.random.random', side_effect=[0, .9, .9, .9, 0, .9, .9]):
            result = self.run_ping([self.pc, self.server], [link('pc-1', 'server', conditions={'lossPct': 50})])
        self.assert_received(result, 2)
        self.assertEqual(sum(p['protocol'] == 'ICMP' and 'echo reply' in p['info'] and
                             p.get('status') == 'delivered' for p in result['packets']), 2)

    def test_self_ping_stays_on_selected_host(self):
        result = self.run_ping([self.pc, self.server], [], command='ping pc-1')
        self.assert_received(result, 4)
        self.assertEqual(result['packets'], [])

    def test_unknown_source_is_not_replaced(self):
        result = self.run_ping([self.pc, self.server], [link('pc-1', 'server')], source='deleted')
        self.assertIn('source device not found', result['output'][0])
        self.assertEqual(result['packets'], [])

    def test_off_subnet_without_route_fails_for_ping_and_traceroute(self):
        self.server['ip'] = '192.168.2.100'
        for command in ['ping server', 'traceroute server']:
            with self.subTest(command=command):
                result = self.run_ping([self.pc, self.server], [link('pc-1', 'server')], command=command)
                self.assertIn('no matching route', '\n'.join(result['output']))
                self.assertFalse(any(p['protocol'] == 'ICMP' for p in result['packets']))

    def test_explicit_router_gateway_path_and_cidr_gateway(self):
        self.server['ip'] = '192.168.2.100'
        self.pc['routes'] = [{'network': '0.0.0.0/0', 'via': '10.10.10.254'}]
        router = host('router', 'router', '10.10.10.254/24')
        result = self.run_ping([self.pc, router, self.server], [link('pc-1', 'router'), link('router', 'server')])
        self.assert_received(result, 4)
        self.assertTrue(any('ttl=63' in line for line in result['output'] if line.startswith('64 bytes')))

    def test_host_cannot_be_a_gateway(self):
        self.server['ip'] = '192.168.2.100'
        self.pc['routes'] = [{'network': '0.0.0.0/0', 'via': '10.10.10.2'}]
        result = self.run_ping([self.pc, host('pc-2', ip='10.10.10.2'), self.server],
                               [link('pc-1', 'pc-2'), link('pc-2', 'server')])
        self.assert_received(result, 0)
        self.assertIn('does not support IP forwarding', '\n'.join(result['output']))

    def test_traceroute_does_not_cross_host(self):
        result = self.run_ping([self.pc, host('pc-2', ip='10.10.10.2'), self.server],
            [link('pc-1', 'pc-2'), link('pc-2', 'server')], command='traceroute server')
        self.assertIn('destination unreachable', '\n'.join(result['output']))

    def test_link_latency_is_in_ping_rtt(self):
        result = self.run_ping([self.pc, self.server], [link('pc-1', 'server', conditions={'latencyMs': 50})])
        self.assert_received(result, 4)
        self.assertTrue(all('time=120.00 ms' in line for line in result['output'] if line.startswith('64 bytes')))

    def test_unknown_hostname_and_unconfigured_target_send_nothing(self):
        for target in ['missing-host', 'empty', 'storage']:
            with self.subTest(target=target):
                result = self.run_ping([self.pc, host('empty', 'server'),
                    host('storage', 'usb-storage')], [], command=f'ping {target}')
                self.assertEqual(result['packets'], [])
                self.assertFalse(any('packets transmitted' in line for line in result['output']))

    def test_unknown_off_subnet_ip_does_not_broadcast_arp(self):
        result = self.run_ping([self.pc], [], command='ping 192.168.2.100')
        self.assert_received(result, 0)
        self.assertEqual(result['packets'], [])

    def test_traceroute_self_does_not_crash(self):
        result = self.run_ping([self.pc, self.server], [], command='traceroute pc-1')
        self.assertIn('0.00 ms', '\n'.join(result['output']))
        self.assertEqual(result['packets'], [])

    def test_switch_flood_does_not_enter_usb_peripherals(self):
        devices = [self.pc, host('switch', 'switch'), self.server, host('storage', 'usb-storage')]
        result = self.run_ping(devices, [link('pc-1', 'switch'), link('switch', 'server'),
            link('switch', 'storage', transport='usb')])
        self.assert_received(result, 4)
        self.assertFalse(any(p.get('toDeviceId') == 'storage' for p in result['packets']))

    def test_firewall_can_be_an_explicit_gateway_and_decrements_ttl(self):
        self.server['ip'] = '192.168.2.100'
        self.pc['routes'] = [{'network': '0.0.0.0/0', 'via': '10.10.10.254'}]
        firewall = host('firewall', 'firewall', '10.10.10.254/24')
        result = self.run_ping([self.pc, firewall, self.server],
            [link('pc-1', 'firewall'), link('firewall', 'server')])
        self.assert_received(result, 4)
        self.assertTrue(all('ttl=63' in line for line in result['output'] if line.startswith('64 bytes')))

    def test_firewall_does_not_bridge_a_flat_subnet_without_a_next_hop_route(self):
        firewall = host('firewall', 'firewall', '10.10.10.254/24')
        result = self.run_ping([self.pc, firewall, self.server],
            [link('pc-1', 'firewall'), link('firewall', 'server')])
        self.assert_received(result, 0)


if __name__ == '__main__':
    unittest.main()
