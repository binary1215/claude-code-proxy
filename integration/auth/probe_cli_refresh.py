"""Unmodified CLI + synthetic tokens + process-local trusted fake HTTPS service."""
import argparse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import time
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cli', required=True, type=Path, help='Unmodified official Claude Code 2.1.318 binary')
parser.add_argument('--output', type=Path, help='Optional safe JSON result file')
parser.add_argument('--coordinator', action='store_true', help='Probe a wrapper running claude-auth refresh; --version must report the official CLI')
args = parser.parse_args()
cli_executable = args.cli.resolve(strict=True)
temporary = tempfile.TemporaryDirectory(prefix='claude-refresh-fixture-')
root = Path(temporary.name)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Isolated synthetic auth test')])
now = datetime.now(timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
    .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5))
    .not_valid_after(now+timedelta(days=1))
    .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
    .add_extension(x509.SubjectAlternativeName([x509.DNSName('platform.claude.com'),
        x509.DNSName('api.anthropic.com')]), critical=False).sign(key, hashes.SHA256()))
cert_path = root / 'fixture-ca.pem'
key_path = root / 'fixture-tls-key.pem'
cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert_path, key_path)
context.set_alpn_protocols(['http/1.1'])
requests = []
reject_refresh = False
transient_failure = False
new_access = 'sk-ant-oat01-SYNTHETIC-ROTATED-NOT-REAL'
new_refresh = 'sk-ant-ort01-SYNTHETIC-ROTATED-NOT-REAL'
scopes = ['user:profile', 'user:inference', 'user:sessions:claude_code']

class MockAPI(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True
    def do_GET(self):
        requests.append({'method': 'GET', 'path': self.path.split('?')[0]})
        self.respond(200, {'account': {'uuid': '00000000-0000-4000-8000-000000000001',
            'email': 'synthetic@example.invalid'}, 'organization': {
                'uuid': '00000000-0000-4000-8000-000000000002', 'organization_type': 'claude_max'}})
    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(min(length, 65536))
        item = {'method': 'POST', 'path': self.path.split('?')[0]}
        requests.append(item)
        if self.path == '/v1/oauth/token':
            body = json.loads(raw)
            item.update(grant_is_refresh=body.get('grant_type') == 'refresh_token',
                public_client_matches=body.get('client_id') == '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
                fixture_refresh_matches=body.get('refresh_token') == 'sk-ant-ort01-SYNTHETIC-NOT-A-REAL-CREDENTIAL')
            if args.coordinator:
                session = json.loads((config / '.proxy-auth-session.json').read_text())
                item['session_established_before_refresh'] = bool(session.get('sessionId'))
                item['_before_session'] = session.get('sessionId')
            if reject_refresh:
                return self.respond(400, {'error': 'invalid_grant', 'error_description': 'Synthetic revoked refresh'})
            if transient_failure:
                return self.respond(503, {'error': 'temporarily_unavailable'})
            return self.respond(200, {'access_token': new_access, 'refresh_token': new_refresh,
                'expires_in': 28800, 'refresh_token_expires_in': 31536000,
                'scope': ' '.join(scopes), 'token_type': 'Bearer'})
        self.respond(503, {'error': 'Synthetic test forbids non-auth POST requests'})
    def log_message(self, *args):
        pass

class Proxy(BaseHTTPRequestHandler):
    def do_CONNECT(self):
        if self.path not in ('platform.claude.com:443', 'api.anthropic.com:443'):
            requests.append({'method': 'BLOCKED_CONNECT', 'target': self.path})
            return self.send_error(502)
        self.send_response(200, 'Connection established')
        self.end_headers()
        self.wfile.flush()
        try:
            with context.wrap_socket(self.connection, server_side=True) as tunnel:
                MockAPI(tunnel, self.client_address, self.server)
        except (OSError, ssl.SSLError) as error:
            requests.append({'method': 'TLS_ERROR', 'type': type(error).__name__})
        self.close_connection = True
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
threading.Thread(target=server.serve_forever, daemon=True).start()
results = []
try:
    for label, seconds, reject in [('fresh', 28800, False), ('near_expiry', 120, False),
                                   ('expired', -60, False), ('rejected', -60, True),
                                   ('transient_failure', -60, False)]:
        reject_refresh = reject
        transient_failure = label == 'transient_failure'
        config = root / ('tls-' + label)
        config.mkdir(exist_ok=True)
        expiry = int(time.time() * 1000) + seconds * 1000
        path = config / '.credentials.json'
        path.write_text(json.dumps({'claudeAiOauth': {
            'accessToken': 'sk-ant-oat01-SYNTHETIC-NOT-A-REAL-CREDENTIAL',
            'refreshToken': 'sk-ant-ort01-SYNTHETIC-NOT-A-REAL-CREDENTIAL',
            'expiresAt': expiry, 'scopes': scopes, 'subscriptionType': 'max',
            'rateLimitTier': 'default_claude_max_5x'}}))
        if args.coordinator and label == 'near_expiry':
            (config / '.proxy-auth-refresh.json').write_text(json.dumps({
                'state': 'idle', 'checked_at': datetime.now(timezone.utc).isoformat(),
                'last_success_at': None, 'next_attempt_at': (datetime.now(timezone.utc)+timedelta(hours=7)).isoformat(),
                'failures': 0, 'successes': 0, 'reason': None,
                'access_digest': hashlib.sha256(b'sk-ant-oat01-SYNTHETIC-NOT-A-REAL-CREDENTIAL').hexdigest(),
                'refresh_digest': hashlib.sha256(b'sk-ant-ort01-SYNTHETIC-NOT-A-REAL-CREDENTIAL').hexdigest()}))
        (config / '.claude.json').write_text(json.dumps({'hasCompletedOnboarding': True,
            'oauthAccount': {'accountUuid': '00000000-0000-4000-8000-000000000001',
                'organizationUuid': '00000000-0000-4000-8000-000000000002',
                'emailAddress': 'synthetic@example.invalid', 'billingType': 'stripe_subscription',
                'accountCreatedAt': '2026-01-01T00:00:00Z', 'subscriptionCreatedAt': '2026-01-01T00:00:00Z',
                'ccOnboardingFlags': []}}))
        env = {k: v for k, v in os.environ.items() if not k.startswith(('CLAUDE_', 'ANTHROPIC_'))}
        proxy = f'http://127.0.0.1:{server.server_address[1]}'
        env.update(CLAUDE_CONFIG_DIR=str(config), USERPROFILE=str(config), HOME=str(config),
            DISABLE_AUTOUPDATER='1', DISABLE_UPDATES='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',
            HTTPS_PROXY=proxy, HTTP_PROXY=proxy, ALL_PROXY=proxy, NO_PROXY='127.0.0.1,localhost',
            NODE_EXTRA_CA_CERTS=str(cert_path), SSL_CERT_FILE=str(cert_path))
        if not results:
            version = subprocess.run([str(cli_executable), '--version'], env=env, cwd=config,
                capture_output=True, text=True, encoding='utf8', timeout=20)
            assert version.returncode == 0 and version.stdout.strip() == '2.1.318 (Claude Code)'
        requests.clear()
        started = time.monotonic()
        command = [str(cli_executable), 'refresh'] if args.coordinator else [str(cli_executable), 'auth', 'status']
        proc = subprocess.run(command, env=env, cwd=config,
            stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=40)
        try:
            reported = json.loads(proc.stdout)
        except ValueError:
            reported = {}
        after = json.loads(path.read_text()).get('claudeAiOauth', {})
        row = {'case': label, 'exit_code': proc.returncode, 'reported_logged_in': reported.get('loggedIn'),
            'access_rotated': after.get('accessToken') == new_access,
            'refresh_rotated': after.get('refreshToken') == new_refresh,
            'expiry_advanced': after.get('expiresAt', 0) > expiry,
            'requests': list(requests), 'elapsed_seconds': round(time.monotonic()-started, 2)}
        if args.coordinator:
            record = json.loads((config / '.proxy-auth-refresh.json').read_text())
            row['coordinator_state'] = record['state']
            session_file = config / '.proxy-auth-session.json'
            session_after = json.loads(session_file.read_text()).get('sessionId') if session_file.exists() else None
            previous_ids = [r.pop('_before_session') for r in row['requests'] if '_before_session' in r]
            row['session_preserved'] = bool(previous_ids) and all(s == session_after for s in previous_ids)
            if label in ('rejected', 'transient_failure'):
                requests.clear()
                subprocess.run(command, env=env, cwd=config, stdin=subprocess.DEVNULL,
                    capture_output=True, timeout=40, check=True)
                row['immediate_repeat_auth_requests'] = len(requests)
                assert not requests, 'Terminal failure/backoff must suppress immediate repeat'
            if os.name == 'posix':
                import fcntl
                requests.clear()
                with (config / '.proxy-auth.lock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    blocked = subprocess.run(command, env=env, cwd=config, stdin=subprocess.DEVNULL,
                        capture_output=True, timeout=40)
                    assert blocked.returncode == 75 and not requests, 'Shared auth lock must exclude overlap'
                    row['concurrent_lock_excluded'] = True
        assert not any(r.get('path', '').startswith('/v1/messages') for r in requests), 'Unexpected inference request'
        print(json.dumps(row), flush=True)
        results.append(row)
finally:
    server.shutdown()
expected_rotations = {'fresh': False, 'near_expiry': True, 'expired': True,
                      'rejected': False, 'transient_failure': False}
for row in results:
    expected = expected_rotations[row['case']]
    assert row['access_rotated'] == expected, row['case']
    assert row['refresh_rotated'] == expected, row['case']
    assert row['expiry_advanced'] == expected, row['case']
    assert row['exit_code'] == (1 if row['case'] == 'rejected' and not args.coordinator else 0), row['case']
    if args.coordinator:
        expected_state = {'fresh': 'idle', 'near_expiry': 'refreshed', 'expired': 'refreshed',
                          'rejected': 'login_required', 'transient_failure': 'retrying'}[row['case']]
        assert row['coordinator_state'] == expected_state, row['case']
        if expected: assert row['session_preserved'], row['case']
summary = {'cli_version_under_test': '2.1.318', 'platform': os.name,
    'official_binary_modified': False, 'synthetic_credentials_only': True,
    'tls_verification_disabled': False, 'coordinator': args.coordinator, 'cases': results}
if args.output:
    args.output.resolve().write_text(json.dumps(summary, indent=2))
temporary.cleanup()

