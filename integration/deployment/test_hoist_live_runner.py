"""No Docker/provider calls: guard checks for the explicit live host runner."""
import contextlib
import copy
import io
import json
import subprocess
import unittest
from unittest.mock import patch

import run_hoist_live_probe as probe


def source():
    return {'Id': probe.SOURCE_ID, 'Image': probe.SOURCE_IMAGE, 'State': {'Running': True, 'StartedAt': 'fixed'},
            'Config': {'Env': ['DATABASE_PATH=/app/data/proxy.db', 'ANTHROPIC_BASE_URL=https://api.anthropic.com']},
            'Mounts': [{'Name': 'test-claudemock-data', 'Destination': '/app/data', 'RW': True}]}


def candidate():
    return {'Name': '/fixture', 'Image': probe.CANDIDATE,
            'Config': {'Image': probe.CANDIDATE, 'User': '1000:1000', 'Labels': {probe.LABEL: 'owner', 'io.claude-relay.fixture-kind': probe.KIND}},
            'HostConfig': {'NetworkMode': 'bridge', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'], 'Privileged': False,
                           'SecurityOpt': ['no-new-privileges:true'], 'PidsLimit': 64, 'Memory': 512 * 1024 * 1024,
                           'Tmpfs': {'/tmp': 'rw', '/app/data': 'rw'}, 'PortBindings': {}, 'Binds': None}, 'Mounts': []}


class LiveRunnerGuards(unittest.TestCase):
    def test_every_wrapped_command_pins_local_socket(self):
        with patch.object(probe, 'bounded_docker', return_value=(0, b'', b'')) as command:
            probe.run(['start', 'fixture'], timeout=20)
            command.assert_called_once_with([probe.SOCKET, 'start', 'fixture'], source=None, timeout=20)

    def test_inspection_does_not_treat_daemon_failure_as_absence(self):
        with patch.object(probe, 'run', return_value=(1, b'', b'permission denied')), self.assertRaises(probe.HarnessError):
            probe.inspect('container', 'fixture', optional=True)
        with patch.object(probe, 'run', return_value=(1, b'', b'Error: No such container: fixture')):
            self.assertIsNone(probe.inspect('container', 'fixture', optional=True))

    def test_live_requires_explicit_option_before_docker(self):
        with patch.object(probe, 'inspect') as inspect, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                probe.main([])
            inspect.assert_not_called()

    def test_nondefault_docker_environment_rejected_before_secret_read(self):
        with patch.dict(probe.os.environ, {'DOCKER_HOST': 'tcp://fixture.invalid'}, clear=True), patch.object(probe, 'credential') as credential:
            with self.assertRaises(SystemExit):
                probe.main(['--allow-live-haiku-oauth'])
            credential.assert_not_called()

    def test_source_identity_and_provider_must_match(self):
        probe.require_source(source())
        for key, value in [('Id', 'changed'), ('Image', 'changed'), ('State', {'Running': False}),
                           ('Config', {'Env': ['DATABASE_PATH=/tmp/other']}),
                           ('Config', {'Env': ['DATABASE_PATH=/app/data/proxy.db', 'ANTHROPIC_BASE_URL=https://untrusted.invalid']})]:
            changed = source()
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(probe.HarnessError):
                probe.require_source(changed)

    def test_credential_read_error_has_no_fallback_and_no_private_error_echo(self):
        with patch.object(probe, 'run', return_value=(1, b'PRIVATE_TOKEN', b'PRIVATE_ERROR')):
            with self.assertRaisesRegex(probe.HarnessError, '^selected_oauth_unavailable_no_fallback$'):
                probe.credential()

    def test_credential_response_requires_oauth_and_known_source(self):
        for raw in [b'not-json', b'{}', b'[]', b'null', b'"string"', b'{"token":"sk-ant-api-private","source":"environment"}',
                    b'{"token":"sk-ant-oat-synthetic","source":"unknown"}']:
            with patch.object(probe, 'run', return_value=(0, raw, b'')), self.assertRaises(probe.HarnessError):
                probe.credential()
        with patch.object(probe, 'run', return_value=(0, b'{"token":"sk-ant-oat-synthetic","source":"database"}', b'')) as command:
            self.assertEqual(probe.credential()['source'], 'database')
            self.assertEqual(command.call_args.args[0][:2], ['exec', probe.SOURCE_ID])

    def test_cleanup_requires_exact_name_owner_kind_and_image(self):
        self.assertTrue(probe.owned(candidate(), 'fixture', 'owner'))
        self.assertFalse(probe.owned(candidate(), 'other', 'owner'))
        self.assertFalse(probe.owned(candidate(), 'fixture', 'other'))
        for key in ['Image', 'Name']:
            changed = candidate()
            changed[key] = 'other'
            self.assertFalse(probe.owned(changed, 'fixture', 'owner'))
        changed = candidate()
        changed['Config']['Image'] = 'mutable-tag'
        self.assertFalse(probe.owned(changed, 'fixture', 'owner'))

    def test_isolation_rejects_mounts_ports_privilege_network_and_writable_root(self):
        self.assertTrue(probe.isolation(candidate()))
        for key, value in [('NetworkMode', 'host'), ('ReadonlyRootfs', False), ('Privileged', True),
                           ('CapDrop', []), ('PortBindings', {'3456/tcp': [{}]}), ('Binds', ['/private:/app/data']),
                           ('PidsLimit', 0), ('Memory', 0), ('Tmpfs', {'/tmp': 'rw'})]:
            changed = candidate()
            changed['HostConfig'][key] = value
            self.assertFalse(probe.isolation(changed), key)
        changed = candidate()
        changed['Mounts'] = [{'Type': 'volume', 'Name': 'production'}]
        self.assertFalse(probe.isolation(changed))

    def test_public_source_identity_never_contains_env_values(self):
        changed = source()
        changed['Config']['Env'].append('CLAUDE_CODE_OAUTH_TOKEN=PRIVATE_TOKEN')
        self.assertNotIn('PRIVATE_TOKEN', str(probe.source_identity(changed)))
        self.assertEqual(probe.source_identity(changed), probe.source_identity(copy.deepcopy(changed)))

    def test_uncertain_create_is_not_declared_clean_after_one_absent_read(self):
        output = io.StringIO()
        sequence = [source(), {'Id': probe.CANDIDATE, 'Config': {'User': 'node'}}, None, None, source()]
        with patch.dict(probe.os.environ, {}, clear=True), patch.object(probe, 'inspect', side_effect=sequence), \
                patch.object(probe, 'credential', return_value={'token': 'sk-ant-oat-synthetic', 'source': 'environment'}), \
                patch.object(probe.subprocess, 'run', side_effect=subprocess.TimeoutExpired('docker', 20)), \
                contextlib.redirect_stdout(output):
            self.assertEqual(probe.main(['--allow-live-haiku-oauth']), 1)
        report = json.loads(output.getvalue())
        self.assertFalse(report['pass'])
        self.assertFalse(report['cleanup_complete'])
        self.assertFalse(report['existing_service_changed'])
        self.assertRegex(report['remaining_container'], '^claude-hoist-live-[a-f0-9]{12}$')
        self.assertNotIn('sk-ant-oat-synthetic', output.getvalue())


if __name__ == '__main__':
    unittest.main()
