#!/usr/bin/env python3
"""Exact-image, fresh-volume, network-none qualification. No build/pull/remote calls."""
import argparse
import json
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path

BASELINE = 'sha256:12d35112176de03ab3d1e2ae46a91a8ca6a98168478c98fd6aaf37fcb9b85fc3'
CANDIDATE = 'sha256:8e7e8f474262dde1ed995ddb99c7b4086c26e15ad2c41b1ea3f8bb8eaed989aa'
OWNER_LABEL = 'io.claude-relay.lifecycle-owner'
KIND_LABEL = 'io.claude-relay.fixture-kind'
KIND = 'synthetic-lifecycle-v1'
PHASES = ('baseline_seed','baseline_restart','candidate_mint','candidate_restart_replay',
          'candidate_wrong_key','baseline_rollback','candidate_reupgrade_replay')
OUTPUT_LIMIT = 65536


class HarnessError(Exception):
    pass


def require_image_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise HarnessError('image_id_required')
    return value


def owned_volume(info, name, owner):
    return (info.get('Name') == name and info.get('Driver') == 'local'
            and not info.get('Options')
            and (info.get('Labels') or {}).get(OWNER_LABEL) == owner
            and (info.get('Labels') or {}).get(KIND_LABEL) == KIND)


def owned_container(info, name, owner, image):
    labels = info.get('Config', {}).get('Labels') or {}
    return (info.get('Name') == '/' + name and info.get('Image') == image
            and info.get('Config', {}).get('Image') == image
            and labels.get(OWNER_LABEL) == owner and labels.get(KIND_LABEL) == KIND)


def isolated_container(info, volume):
    host = info.get('HostConfig') or {}
    mounts = info.get('Mounts') or []
    return (info.get('Config', {}).get('User') == '1000:1000'
            and host.get('NetworkMode') == 'none' and host.get('ReadonlyRootfs') is True
            and host.get('CapDrop') == ['ALL']
            and any(value in ('no-new-privileges','no-new-privileges:true') for value in host.get('SecurityOpt', []))
            and host.get('PidsLimit') == 64 and host.get('Memory') == 512 * 1024 * 1024
            and not host.get('Privileged') and not host.get('PortBindings')
            and not host.get('Binds') and host.get('Tmpfs', {}).get('/tmp') == 'rw,noexec,nosuid,nodev,size=16m'
            and len(mounts) == 1 and mounts[0].get('Type') == 'volume'
            and mounts[0].get('Name') == volume and mounts[0].get('Destination') == '/app/data'
            and mounts[0].get('RW') is True)


def run(args, source=None, timeout=15):
    """Bound both output channels before parsing; never relay Docker/app logs."""
    proc = subprocess.Popen(['docker', *args], stdin=subprocess.PIPE if source is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    buffers = [bytearray(), bytearray()]
    limit = threading.Event()
    lock = threading.Lock()

    def reader(pipe, index):
        while True:
            chunk = pipe.read(4096)
            if not chunk:
                return
            with lock:
                if sum(map(len, buffers)) + len(chunk) > OUTPUT_LIMIT:
                    limit.set()
                    proc.kill()
                    return
                buffers[index].extend(chunk)

    threads = [threading.Thread(target=reader, args=(pipe, i), daemon=True)
               for i, pipe in enumerate((proc.stdout, proc.stderr))]
    for thread in threads:
        thread.start()
    try:
        if source is not None:
            # A stuck Docker stdin must not hold the phase deadline hostage.
            if len(source) > 60000:
                raise HarnessError('helper_size_limit')
            def writer():
                try:
                    proc.stdin.write(source)
                    proc.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
            input_thread = threading.Thread(target=writer, daemon=True)
            input_thread.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
            raise HarnessError('command_timeout') from None
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        for thread in threads:
            thread.join(timeout=2)
        for pipe in (proc.stdout, proc.stderr):
            pipe.close()
    if limit.is_set():
        raise HarnessError('command_output_limit')
    return proc.returncode, bytes(buffers[0]), bytes(buffers[1])


def inspect(kind, name, optional=False):
    code, output, error = run([kind, 'inspect', name])
    if code:
        # Do not interpret daemon/permission/transport errors as absent resources.
        expected_absent = ('no such ' + kind).encode('ascii')
        if optional and expected_absent in error.lower():
            return None
        raise HarnessError('resource_inspection_failed')
    try:
        result = json.loads(output)
        if len(result) != 1 or not isinstance(result[0], dict):
            raise ValueError()
        return result[0]
    except (ValueError, TypeError, KeyError):
        raise HarnessError('resource_inspection_invalid') from None


def container_args(name, owner, volume, image, phase):
    require_image_id(image)
    return ['run', '--pull=never', '--name', name,
            '--label', OWNER_LABEL + '=' + owner, '--label', KIND_LABEL + '=' + KIND,
            '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
            '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
            '--mount', 'type=volume,source=' + volume + ',target=/app/data',
            '--workdir=/app', '--entrypoint=node', '-i', image, '--input-type=module', '-', phase]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-id', required=True)
    parser.add_argument('--candidate-id', required=True)
    options = parser.parse_args(argv)
    report = {'pass': False, 'phases': [], 'cleanup_complete': False,
              'remaining_resources': [], 'recreation_not_docker_restart': True,
              'backup_restore_qualified': False}
    owner = uuid.uuid4().hex
    volume = 'claude-lifecycle-' + owner
    containers = []
    volume_attempted = False
    try:
        baseline, candidate = map(require_image_id, (options.baseline_id, options.candidate_id))
        if baseline != BASELINE or candidate != CANDIDATE:
            raise HarnessError('unqualified_image_pair')
        report.update(baseline_image=baseline, candidate_image=candidate)
        for image in (baseline, candidate):
            info = inspect('image', image)
            if info.get('Id') != image or info.get('Config', {}).get('User') not in ('node','1000','1000:1000'):
                raise HarnessError('unexpected_image_identity_or_user')
        source = Path(__file__).with_name('lifecycle_phase.mjs').read_bytes()
        if len(source) > 60000:
            raise HarnessError('helper_size_limit')
        if inspect('volume', volume, optional=True) is not None:
            raise HarnessError('fresh_volume_collision')
        volume_attempted = True
        code, _, _ = run(['volume', 'create', '--driver=local', '--label', OWNER_LABEL + '=' + owner,
                          '--label', KIND_LABEL + '=' + KIND, volume])
        if code or not owned_volume(inspect('volume', volume), volume, owner):
            raise HarnessError('volume_creation_failed')
        for index, phase in enumerate(PHASES):
            image = baseline if phase.startswith('baseline_') else candidate
            name = volume + '-' + str(index)
            containers.append((name, image))
            code, output, _ = run(container_args(name, owner, volume, image, phase), source, timeout=35)
            info = inspect('container', name)
            if not owned_container(info, name, owner, image):
                raise HarnessError('container_ownership_mismatch')
            if not isolated_container(info, volume):
                raise HarnessError('container_isolation_mismatch')
            try:
                result = json.loads(output)
                # Output is one closed-schema summary; arbitrary runtime text is not retained.
                allowed = {'phase','pass','provider_calls','history_rows','old_history_exact','active_key_acl',
                           'revoked_key_rejected','no_stored_content','backup_integrity_checked','state_replay_exact',
                           'changed_key_rejected_before_provider','rollback_native_only','failure'}
                if not isinstance(result, dict) or set(result) - allowed or result.get('phase') != phase:
                    raise ValueError()
                for key, value in result.items():
                    if key not in ('phase','failure') and not isinstance(value, (bool,int)):
                        raise ValueError()
                if result.get('failure') not in (None,'startup','application_contract','phase_deadline'):
                    raise ValueError()
            except (ValueError, TypeError):
                raise HarnessError('phase_output_invalid') from None
            report['phases'].append(result)
            if code or info.get('State', {}).get('ExitCode') != 0 or result.get('pass') is not True:
                raise HarnessError('phase_failed')
        report['pass'] = True
    except (HarnessError, OSError) as error:
        report['failure'] = str(error) if isinstance(error, HarnessError) else 'local_runtime_unavailable'
    finally:
        # Ownership checks precede every destructive call, including partial-start failures.
        for name, image in reversed(containers):
            try:
                info = inspect('container', name, optional=True)
                if info is None:
                    continue
                if not owned_container(info, name, owner, image):
                    raise HarnessError('cleanup_ownership_mismatch')
                code, _, _ = run(['container', 'rm', '--force', name])
                if code or inspect('container', name, optional=True) is not None:
                    raise HarnessError('cleanup_failed')
            except (HarnessError, OSError):
                report['remaining_resources'].append({'kind':'container','name':name})
        if volume_attempted:
            try:
                info = inspect('volume', volume, optional=True)
                if info is not None:
                    if report['remaining_resources'] or not owned_volume(info, volume, owner):
                        raise HarnessError('cleanup_ownership_mismatch')
                    code, _, _ = run(['volume', 'rm', volume])
                    if code or inspect('volume', volume, optional=True) is not None:
                        raise HarnessError('cleanup_failed')
            except (HarnessError, OSError):
                report['remaining_resources'].append({'kind':'volume','name':volume})
        report['cleanup_complete'] = not report['remaining_resources']
        report['pass'] = report['pass'] and report['cleanup_complete']
    print(json.dumps(report, separators=(',', ':')))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
