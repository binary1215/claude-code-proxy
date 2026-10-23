"""No-inference Responses route probe; prints only closed diagnostic categories.

The key is read from the named environment variable, never from CLI arguments.
An empty JSON body cannot request inference from this proxy's Responses adapter.
This checks gateway authentication/route reachability, NOT provider entitlement.
"""
import argparse
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def endpoint(base):
    value = urllib.parse.urlsplit(base)
    if (value.scheme not in ('http', 'https') or not value.hostname
            or value.username or value.password or value.query or value.fragment):
        raise ValueError('invalid_base_url')
    path = value.path.rstrip('/')
    if not path.endswith('/v1'):
        path += '/v1'
    return urllib.parse.urlunsplit((value.scheme, value.netloc, path + '/responses', '', ''))


def classify(status, raw):
    try:
        payload = json.loads(raw)
        error = payload.get('error', {}) if isinstance(payload, dict) else {}
        if not isinstance(error, dict):
            error = {}
    except (ValueError, UnicodeError):
        error = {}
    # Use structured fields only. Never echo message/body or infer a provider
    # rejection merely from an HTTP status. A custom route may have other targets.
    kind, code = error.get('type'), error.get('code')
    if status == 401 and ('expired_key' in (kind, code) or 'key_expired' in (kind, code)):
        category, layer = 'gateway_key_expired', 'gateway_authentication'
    elif status == 401:
        category, layer = 'authentication_rejected', 'unconfirmed'
    elif status == 403:
        category, layer = 'access_denied', 'unconfirmed'
    elif status == 400 and code == 'invalid_model':
        category, layer = 'adapter_validation_reached', 'responses_adapter'
    elif status == 404:
        category, layer = 'route_not_found', 'unconfirmed'
    elif 300 <= status < 400:
        category, layer = 'redirect_not_followed', 'unconfirmed'
    elif 200 <= status < 300:
        category, layer = 'unexpected_success_for_empty_request', 'unconfirmed'
    else:
        category, layer = 'other_http_response', 'unconfirmed'
    return {'http_status': status, 'category': category, 'layer': layer,
            'route_usable_for_validation': category == 'adapter_validation_reached',
            'provider_authentication_tested': False, 'model_requested': False}


def probe(url, key):
    request = urllib.request.Request(url, data=b'{}', method='POST',
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return classify(response.code, response.read(65536))
    except (OSError, urllib.error.URLError):
        return {'http_status': None, 'category': 'transport_failed', 'layer': 'unconfirmed',
                'route_usable_for_validation': False, 'provider_authentication_tested': False,
                'model_requested': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True, help='Gateway Responses base, e.g. http://host:4000/claude-responses/v1')
    parser.add_argument('--key-env', required=True, help='Environment variable name, never the key value')
    args = parser.parse_args()
    try:
        url = endpoint(args.base_url)
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', args.key_env):
            raise ValueError('invalid_environment_name')
        key = os.environ.get(args.key_env, '')
        if not key or any(ord(c) < 33 or ord(c) > 126 for c in key):
            raise ValueError('missing_or_invalid_key')
    except ValueError:
        print(json.dumps({'category': 'invalid_local_configuration', 'model_requested': False}))
        return 2
    result = probe(url, key)
    print(json.dumps(result))
    return 0 if result['route_usable_for_validation'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
