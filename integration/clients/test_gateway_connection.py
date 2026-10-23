"""Pure diagnostic classification tests; no network, credentials or inference."""
import json
import unittest
import check_gateway_connection as check


class ConnectionTests(unittest.TestCase):
    def test_responses_namespace(self):
        for base in ('http://example.test:4000/claude-responses', 'http://example.test:4000/claude-responses/v1/'):
            self.assertEqual(check.endpoint(base), 'http://example.test:4000/claude-responses/v1/responses')

    def test_credential_url_and_redirect_input_rejected(self):
        for value in ('http://user:password@example.test', 'file:///tmp/file', 'http://example.test?token=private'):
            with self.assertRaises(ValueError):
                check.endpoint(value)

    def test_expired_key_is_not_provider_restriction(self):
        value = check.classify(401, b'{"error":{"type":"expired_key","message":"PRIVATE"}}')
        self.assertEqual(value['category'], 'gateway_key_expired')
        self.assertEqual(value['layer'], 'gateway_authentication')
        self.assertFalse(value['provider_authentication_tested'])
        self.assertNotIn('PRIVATE', json.dumps(value))

    def test_403_does_not_invent_origin(self):
        value = check.classify(403, b'{"error":{"type":"permission_error"}}')
        self.assertEqual(value['category'], 'access_denied')
        self.assertEqual(value['layer'], 'unconfirmed')

    def test_adapter_validation_is_not_model_success(self):
        value = check.classify(400, b'{"error":{"type":"invalid_request_error","code":"invalid_model"}}')
        self.assertTrue(value['route_usable_for_validation'])
        self.assertFalse(value['provider_authentication_tested'])
        self.assertFalse(value['model_requested'])

    def test_unknown_and_redirect_remain_unknown(self):
        for body in (b'private error text', b'null', b'{"error":null}'):
            self.assertEqual(check.classify(400, body)['category'], 'other_http_response')
        self.assertEqual(check.classify(302, b'')['category'], 'redirect_not_followed')
        self.assertEqual(check.classify(200, b'{}')['category'], 'unexpected_success_for_empty_request')


if __name__ == '__main__':
    unittest.main()
