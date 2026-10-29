import os
from pathlib import Path
import time
import unittest
from unittest.mock import Mock, patch
from flask import Flask
from discovery import DiscoveryError, DiscoveryManager, discovery_blueprint, choose_target, network_snapshot, verify_local_routes

SAMPLE = (Path(__file__).resolve().parent.parent / 'frontend/src/examples/nmap-sample.xml').read_bytes()
NETWORK = dict(id='eth-test:10.0.0.10/24', interface='eth-test', address='10.0.0.10',
               connectedCidr='10.0.0.0/24', suggestedCidr='10.0.0.0/24', gateway='10.0.0.1')
SNAPSHOT = dict(networks=[NETWORK], routes=[dict(dst='10.0.0.0/24', dev='eth-test')], restrictedRouting=False)


class FakeProcess:
    def __init__(self, output, content=SAMPLE, hang=False, returncode=0):
        output.write(content); output.flush()
        self.returncode = None if hang else returncode
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, NETWORK_LAB_DISCOVERY='1'); self.env.start()
        self.which = patch('discovery.shutil.which', side_effect=lambda name: '/usr/bin/' + name); self.which.start()
        self.platform = patch('discovery.sys.platform', 'linux'); self.platform.start()
        self.spawned = []
        self.content = SAMPLE; self.hang = False; self.exit_code = 0
        def spawn(command, **options):
            process = FakeProcess(options['stdout'], self.content, self.hang, self.exit_code)
            self.spawned.append((command, process, options))
            return process
        self.reader = Mock(return_value=SNAPSHOT)
        self.manager = DiscoveryManager(network_reader=self.reader, neighbor_reader=lambda network: [], spawn=spawn)
        self.app = Flask(__name__); self.app.register_blueprint(discovery_blueprint(self.manager))
        self.client = self.app.test_client()
        self.auth = {'Authorization': f'Bearer {self.manager.token}'}

    def tearDown(self):
        self.manager.shutdown()
        for patcher in (self.platform, self.which, self.env): patcher.stop()

    def start(self, **fields):
        return self.client.post('/api/discovery/jobs', json={**dict(interfaceId=NETWORK['id'], cidr='10.0.0.0/24'), **fields}, headers=self.auth)

    def finish(self, identifier):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            job = self.manager.get(identifier)
            if job['status'] not in ('queued', 'running'): return job
            time.sleep(.02)
        self.fail('Discovery worker did not finish')

    def test_disabled_feature_exposes_no_networks_or_token_and_cannot_start(self):
        with patch.dict(os.environ, NETWORK_LAB_DISCOVERY='0'):
            result = self.client.get('/api/discovery/capabilities')
            self.assertFalse(result.json['enabled'])
            self.assertNotIn('token', result.json)
            self.assertNotIn('networks', result.json)
            self.assertEqual(self.start().status_code, 403)
            self.reader.assert_not_called()

    def test_capabilities_only_read_settings_and_never_start_a_scan(self):
        response = self.client.get('/api/discovery/capabilities')
        self.assertTrue(response.json['canStart'])
        self.assertEqual(response.json['networks'][0]['gateway'], '10.0.0.1')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(self.spawned, [])

    def test_remote_peers_public_hosts_hostile_origins_and_cross_site_requests_are_denied(self):
        for options in [dict(environ_overrides={'REMOTE_ADDR': '192.168.1.2'}),
                        dict(base_url='https://network-lab.example.com'),
                        dict(headers={'Origin': 'https://evil.example'}),
                        dict(headers={'Origin': 'null'}),
                        dict(headers={'X-Forwarded-For': '198.51.100.10'}),
                        dict(headers={'X-Real-IP': '198.51.100.10'}),
                        dict(headers={'X-Forwarded-Host': 'public.example'}),
                        dict(headers={'Forwarded': 'for=198.51.100.10'}),
                        dict(headers={'Sec-Fetch-Site': 'cross-site'})]:
            with self.subTest(options=options):
                response = self.client.get('/api/discovery/capabilities', **options)
                self.assertEqual(response.status_code, 403)
                self.assertNotIn('token', response.json)

    def test_local_vite_origin_is_allowed_but_other_local_origins_are_not(self):
        self.assertEqual(self.client.get('/api/discovery/capabilities', headers={'Origin': 'http://localhost:3000'}).status_code, 200)
        self.assertEqual(self.client.get('/api/discovery/capabilities', headers={'Origin': 'http://localhost:9999'}).status_code, 403)

    def test_job_endpoints_require_session_token(self):
        self.assertEqual(self.client.post('/api/discovery/jobs', json={}).status_code, 403)
        self.assertEqual(self.client.get('/api/discovery/jobs/unknown').status_code, 403)
        self.assertEqual(self.client.delete('/api/discovery/jobs/unknown').status_code, 403)
        self.assertEqual(self.spawned, [])

    def test_scope_rejects_large_public_off_link_malformed_and_injection_targets(self):
        for cidr in ['10.0.0.0/16', '192.168.1.0/24', '8.8.8.0/24', '10.0.0.1/24', '10.0.0.0/24; touch /tmp/no', '--script=all', '::1/128']:
            with self.subTest(cidr=cidr):
                self.assertEqual(self.start(cidr=cidr).status_code, 400)
        self.assertEqual(self.spawned, [])

    def test_removed_interface_is_rejected_but_unrelated_policy_rules_are_verified(self):
        self.reader.return_value = {**SNAPSHOT, 'networks': []}
        self.assertEqual(self.start().status_code, 400)
        self.reader.return_value = {**SNAPSHOT, 'restrictedRouting': True}
        self.manager.route_checker = Mock()
        capabilities = self.client.get('/api/discovery/capabilities').json
        self.assertTrue(capabilities['canStart'])
        self.assertIn('verified', capabilities['routingNotice'])
        result = self.finish(self.start().json['id'])
        self.assertEqual(result['status'], 'completed')
        self.manager.route_checker.assert_called_once()

    def test_more_specific_redirecting_route_is_rejected(self):
        snapshot = {**SNAPSHOT, 'routes': [dict(dst='10.0.0.128/25', dev='tun0')]}
        with self.assertRaises(DiscoveryError): choose_target(snapshot, NETWORK['id'], '10.0.0.0/24')
        self.assertEqual(choose_target(snapshot, NETWORK['id'], '10.0.0.0/25')['addressCount'], 128)

    def test_fixed_command_has_no_port_scan_scripts_or_shell_and_returns_xml(self):
        response = self.start()
        self.assertEqual(response.status_code, 202)
        result = self.finish(response.json['id'])
        self.assertEqual(result['status'], 'completed')
        command, _, options = self.spawned[0]
        self.assertEqual(command, ['/usr/bin/nmap', '--unprivileged', '-sn', '-n', '-T3', '--max-retries', '1', '--host-timeout', '5s', '--max-rate', '32', '-oX', '-', '10.0.0.0/24'])
        self.assertNotIn('shell', options)
        self.assertIn('<nmaprun', result['xml'])
        self.assertNotIn('token', result)
        self.assertIn('startedAt', result)

    def test_cancellation_stops_scanner_and_concurrent_jobs_are_blocked(self):
        self.hang = True
        response = self.start(); identifier = response.json['id']
        deadline = time.monotonic() + 1
        while not self.spawned and time.monotonic() < deadline: time.sleep(.01)
        self.assertEqual(self.start().status_code, 409)
        self.assertEqual(self.client.delete(f'/api/discovery/jobs/{identifier}', headers=self.auth).status_code, 200)
        self.assertEqual(self.finish(identifier)['status'], 'cancelled')
        self.assertTrue(self.spawned[0][1].terminated)

    def test_timeout_stops_process_and_surfaces_failure(self):
        self.hang = True; self.manager.timeout = .01
        result = self.finish(self.start().json['id'])
        self.assertEqual(result['status'], 'failed')
        self.assertIn('timed out', result['error'])
        self.assertTrue(self.spawned[0][1].terminated)

    def test_bad_scanner_result_failure_and_output_limit(self):
        for content, exit_code in [(b'', 0), (SAMPLE, 2), (b'x' * (5 * 1024 * 1024 + 1), 0)]:
            self.content = content; self.exit_code = exit_code
            self.assertEqual(self.finish(self.start().json['id'])['status'], 'failed')

    def test_missing_nmap_and_unsupported_platform_are_explained(self):
        with patch('discovery.shutil.which', return_value=None):
            self.assertFalse(self.client.get('/api/discovery/capabilities').json['canStart'])
            self.assertEqual(self.start().status_code, 503)
        with patch('discovery.sys.platform', 'win32'):
            self.assertFalse(self.client.get('/api/discovery/capabilities').json['supported'])
            self.assertEqual(self.start().status_code, 503)

    def test_recent_result_can_be_recovered_and_expires(self):
        identifier = self.start().json['id']; self.finish(identifier)
        self.assertEqual(self.client.get('/api/discovery/capabilities').json['recentJob'], identifier)
        self.manager.jobs[identifier]['ended'] = time.monotonic() - 901
        self.assertEqual(self.client.get(f'/api/discovery/jobs/{identifier}', headers=self.auth).status_code, 404)

    def test_network_detection_excludes_virtual_public_and_down_interfaces(self):
        addresses = [dict(ifname='wlan0', operstate='UP', flags=['UP'], addr_info=[dict(local='192.168.50.10', prefixlen=16)]),
                     dict(ifname='docker0', operstate='UP', flags=['UP'], addr_info=[dict(local='172.17.0.1', prefixlen=16)]),
                     dict(ifname='eth-down', operstate='DOWN', flags=[], addr_info=[dict(local='10.1.1.2', prefixlen=24)]),
                     dict(ifname='eth-public', operstate='UP', flags=['UP'], addr_info=[dict(local='203.0.113.1', prefixlen=24)])]
        with patch('discovery.ip_json', side_effect=[addresses, [dict(dst='default', dev='wlan0', gateway='192.168.50.1')], [dict(table='main'), dict(table='local'), dict(table='default')]]):
            snapshot = network_snapshot()
        self.assertEqual(len(snapshot['networks']), 1)
        self.assertEqual(snapshot['networks'][0]['suggestedCidr'], '192.168.50.0/24')
        self.assertEqual(snapshot['networks'][0]['gateway'], '192.168.50.1')

    def test_policy_route_failure_prevents_scanner_launch(self):
        self.reader.return_value = {**SNAPSHOT, 'restrictedRouting': True}
        self.manager.route_checker = Mock(side_effect=DiscoveryError('The route uses a VPN interface.'))
        result = self.finish(self.start().json['id'])
        self.assertEqual(result['status'], 'failed')
        self.assertIn('VPN', result['error'])
        self.assertEqual(self.spawned, [])

    def test_kernel_route_checks_allow_direct_lan_and_own_local_address(self):
        network = {**NETWORK, 'cidr': '10.0.0.0/30'}
        with patch('discovery.ip_json', side_effect=[
            [{'type': 'local', 'dev': 'lo'}], [{'dev': 'eth-test', 'flags': []}]
        ]) as lookup:
            verify_local_routes(network)
        self.assertEqual(lookup.call_count, 2)
        self.assertEqual(lookup.call_args_list[0].args, ('route', 'get', '10.0.0.1'))

    def test_kernel_route_checks_reject_redirected_or_unreachable_targets(self):
        network = {**NETWORK, 'cidr': '10.0.0.0/30'}
        for result in [[], [{'dev': 'tailscale0'}], [{'dev': 'eth-test', 'gateway': '10.0.0.1'}], [{'dev': 'eth-test', 'flags': ['linkdown']}]]:
            with self.subTest(result=result), patch('discovery.ip_json', return_value=result):
                with self.assertRaises(DiscoveryError): verify_local_routes(network)

    def test_route_verification_can_be_cancelled_before_any_lookup(self):
        with patch('discovery.ip_json') as lookup:
            with self.assertRaises(DiscoveryError):
                verify_local_routes({**NETWORK, 'cidr': '10.0.0.0/24'}, lambda: True)
            lookup.assert_not_called()


if __name__ == '__main__': unittest.main()
