#!/usr/bin/env python3
"""Explicit live qualification on the existing .64 Docker host, not deployment.

Reads the exact existing test container's selected OAuth credential privately;
never prints it or writes a custom secret file. Docker stores injected env in
container metadata until the newly created, labelled container is removed.
This program is NOT a synthetic/network-none lifecycle fixture.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

from lifecycle_smoke import HarnessError, run as bounded_docker

SOURCE_NAME = 'test-claudemock'
SOURCE_ID = 'e818d18871aef221db9410031c27c9b2993f413d04b424629901109f732f1ccc'
SOURCE_IMAGE = 'sha256:12d35112176de03ab3d1e2ae46a91a8ca6a98168478c98fd6aaf37fcb9b85fc3'
CANDIDATE = 'sha256:1a54131ea9569e3c60c533adb729f95b40d3e13f5b4c9abbd9b7d0811b95974f'
LABEL = 'io.claude-relay.hoist-live-owner'
KIND = 'hoist-haiku-live-v1'
BASE = 'https://api.anthropic.com'
SOCKET = '--host=unix:///var/run/docker.sock'


def run(args, source=None, timeout=15):
    # Pin every command, including cleanup, independently of the CLI's saved
    # current context and any inherited environment/configuration.
    return bounded_docker([SOCKET, *args], source=source, timeout=timeout)


def inspect(kind, name, optional=False):
    code, output, error = run([kind, 'inspect', name])
    if code:
        if optional and ('no such ' + kind).encode('ascii') in error.lower():
            return None
        raise HarnessError('resource_inspection_failed')
    try:
        value = json.loads(output)
        if len(value) != 1 or not isinstance(value[0], dict):
            raise ValueError()
        return value[0]
    except (ValueError, TypeError, KeyError):
        raise HarnessError('resource_inspection_invalid') from None


def source_identity(info):
    return {'id': info.get('Id'), 'image': info.get('Image'),
            'started_at': info.get('State', {}).get('StartedAt'),
            'running': info.get('State', {}).get('Running'),
            'mounts': [(m.get('Name'), m.get('Destination'), m.get('RW')) for m in info.get('Mounts', [])]}


def require_source(info):
    env = dict(item.split('=', 1) for item in info.get('Config', {}).get('Env', []) if '=' in item)
    if (info.get('Id') != SOURCE_ID or info.get('Image') != SOURCE_IMAGE
            or not info.get('State', {}).get('Running')
            or env.get('ANTHROPIC_BASE_URL', BASE).rstrip('/') not in {BASE, BASE + '/v1'}
            or env.get('DATABASE_PATH') != '/app/data/proxy.db'):
        raise HarnessError('source_identity_or_configuration_changed')


def credential():
    # Docker exec stdout is captured inside this host process, never relayed to
    # the report. A readonly SQLite connection follows the actual DB/env priority.
    source = """import Database from 'better-sqlite3';
const db = new Database('/app/data/proxy.db', {readonly:true, fileMustExist:true});
const saved = db.prepare('SELECT value FROM settings WHERE key = ?').get('claude_oauth_token')?.value;
db.close();
const token = saved || process.env.CLAUDE_CODE_OAUTH_TOKEN;
if(typeof token !== 'string' || !token.startsWith('sk-ant-oat') || /[^\\x21-\\x7e]/.test(token)) process.exit(2);
process.stdout.write(JSON.stringify({token,source:saved?'database':'environment'}));"""
    code, output, _ = run(['exec', SOURCE_ID, 'node', '--input-type=module', '-e', source])
    if code:
        raise HarnessError('selected_oauth_unavailable_no_fallback')
    try:
        value = json.loads(output)
        if (not isinstance(value, dict) or not isinstance(value.get('token'), str) or not value['token'].startswith('sk-ant-oat')
                or len(value['token']) > 4096 or value.get('source') not in {'database', 'environment'}):
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError):
        raise HarnessError('selected_oauth_unavailable_no_fallback') from None


def owned(info, name, owner):
    labels = info.get('Config', {}).get('Labels') or {}
    return (info.get('Name') == '/' + name and info.get('Image') == CANDIDATE
            and info.get('Config', {}).get('Image') == CANDIDATE
            and labels.get(LABEL) == owner and labels.get('io.claude-relay.fixture-kind') == KIND)


def isolation(info):
    host = info.get('HostConfig') or {}
    return (info.get('Config', {}).get('User') == '1000:1000'
            and host.get('NetworkMode') == 'bridge' and host.get('ReadonlyRootfs') is True
            and host.get('CapDrop') == ['ALL'] and not host.get('Privileged')
            and any(x in ('no-new-privileges', 'no-new-privileges:true') for x in host.get('SecurityOpt', []))
            and host.get('PidsLimit') == 64 and host.get('Memory') == 512 * 1024 * 1024
            and not host.get('PortBindings') and not host.get('Binds') and not info.get('Mounts')
            and set(host.get('Tmpfs', {})) == {'/tmp', '/app/data'})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-live-haiku-oauth', action='store_true')
    parser.add_argument('--diagnose-once', action='store_true', help='One request only; cannot qualify replay')
    args = parser.parse_args(argv)
    if not args.allow_live_haiku_oauth:
        parser.error('Explicit live-call opt-in is required')
    report = {'pass': False, 'kind': KIND, 'candidate_image': CANDIDATE,
              'existing_service_changed': None, 'cleanup_complete': False,
              'live_provider_calls_possible': True, 'production_gateway_tested': False}
    owner = uuid.uuid4().hex
    name = 'claude-hoist-live-' + owner[:12]
    before = None
    create_uncertain = False
    # A remote Docker context could send the selected token elsewhere. This
    # helper must run on the intended host with its ordinary local socket.
    if any(os.environ.get(key) for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG')):
        raise SystemExit('Non-default Docker environment refused')
    try:
        info = inspect('container', SOURCE_NAME)
        require_source(info)
        before = source_identity(info)
        image = inspect('image', CANDIDATE)
        if image.get('Id') != CANDIDATE or image.get('Config', {}).get('User') != 'node':
            raise HarnessError('candidate_image_identity_changed')
        if inspect('container', name, optional=True) is not None:
            raise HarnessError('candidate_name_exists')
        helper = Path(__file__).with_name('hoist_live_probe.mjs').read_bytes()
        if len(helper) > 60000:
            raise HarnessError('helper_size_limit')
        report['helper_sha256'] = hashlib.sha256(helper).hexdigest()
        selected = credential()
        report['credential_source'] = selected['source']
        env = {key: value for key, value in os.environ.items() if key in {'PATH', 'LANG', 'LC_ALL'}}
        env.update(CLAUDE_CODE_OAUTH_TOKEN=selected['token'], ANTHROPIC_BASE_URL=BASE,
                   HOIST_PROBE_MAX_PROVIDER_CALLS='1' if args.diagnose_once else '3')
        create = ['docker', SOCKET, 'create', '--pull=never', '--name', name,
                  '--label', LABEL + '=' + owner, '--label', 'io.claude-relay.fixture-kind=' + KIND,
                  '--network=bridge', '--read-only', '--user=1000:1000', '--cap-drop=ALL',
                  '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
                  '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
                  '--tmpfs', '/app/data:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=700',
                  '--env', 'CLAUDE_CODE_OAUTH_TOKEN', '--env', 'ANTHROPIC_BASE_URL', '--env', 'HOIST_PROBE_MAX_PROVIDER_CALLS',
                  '--workdir=/app', '--entrypoint=node', '-i', CANDIDATE, '--input-type=module', '-']
        # No argv/custom-file/log secret. Docker retains env in container metadata
        # until owned cleanup; do not treat this as diskless secret injection.
        create_uncertain = True
        created = subprocess.run(create, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        env.clear()
        selected.clear()
        if created.returncode or len(created.stdout) + len(created.stderr) > 65536:
            raise HarnessError('candidate_create_failed')
        create_uncertain = False
        current = inspect('container', name)
        if not owned(current, name, owner) or not isolation(current):
            raise HarnessError('candidate_isolation_mismatch')
        report['isolation_verified'] = True
        # No replay after timeout or uncertain outcome. The helper itself permits
        # at most three sequential provider requests and stops on first failure.
        code, output, _ = run(['start', '-a', '-i', current['Id']], source=helper, timeout=190)
        try:
            result = json.loads(output)
            if not isinstance(result, dict):
                raise ValueError()
        except (ValueError, TypeError):
            raise HarnessError('probe_report_invalid') from None
        report['probe_exit_code'] = code
        report['probe'] = result
        report['pass'] = code == 0 and result.get('outcome') == 'pass'
    except (HarnessError, OSError, subprocess.TimeoutExpired) as error:
        report['failure'] = str(error) if isinstance(error, HarnessError) else 'host_operation_failed'
    finally:
        try:
            current = inspect('container', name, optional=True)
            if current is not None:
                if not owned(current, name, owner):
                    raise HarnessError('cleanup_ownership_mismatch')
                code, _, _ = run(['rm', '-f', current['Id']])
                if code or inspect('container', name, optional=True) is not None:
                    raise HarnessError('cleanup_failed')
                create_uncertain = False
            if create_uncertain:
                # A timed-out create may still finish in the daemon after an
                # absent inspection. Do not report definitive cleanup or retry.
                raise HarnessError('create_outcome_unsettled')
            report['cleanup_complete'] = True
        except HarnessError:
            report['remaining_container'] = name
            report['pass'] = False
        if before is not None:
            try:
                report['existing_service_changed'] = source_identity(inspect('container', SOURCE_NAME)) != before
            except HarnessError:
                report['existing_service_changed'] = None
            if report['existing_service_changed'] is not False:
                report['pass'] = False
    print(json.dumps(report, indent=2))
    return 0 if report['pass'] and report['cleanup_complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
