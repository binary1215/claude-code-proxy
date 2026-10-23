# Stock LiteLLM chain cancellation

This local test checks the actual network chain, not just the proxy's own
disconnect handler:

```text
synthetic HTTP client → stock LiteLLM custom pass-through → built proxy → slow fake Anthropic
```

Both Messages and Responses routes are covered, with direct-to-proxy controls.
The fake sends the beginning of a native SSE response and then stays silent.
Once the client has received SSE bytes and proxy history is still `pending`, it
shuts down its socket. The test independently observes TCP EOF/reset at the fake
upstream and polls sanitized proxy history through a separate loopback probe.

Passing requires one upstream request, the correct native model/path, upstream
socket closure within 2 seconds, and history finalized as `cancelled` with the
`cancelled` diagnostic within 2 seconds. The proxy's deadline is 8 seconds; a
request that remains alive until that deadline fails this test. Timeout or
unexpected errors are not converted to an expected-pass result.

## Run

Build the repository first. Use a Python environment containing pristine
`litellm==1.103.1` with its proxy dependencies and `prisma==0.11.0`:

```powershell
& '<python-environment>/Scripts/python.exe' -B integration/litellm/test_chain_cancellation.py `
  --node '<node-executable>' `
  --output '<new-evidence-directory>'
```

`test_chain_cancellation.py` verifies LiteLLM's package version and the 13 pinned
source identities already defined in `test_stock_gateway.py`, without importing
or executing that other runner. It verifies them again after the test. Existing
evidence is never overwritten.

The harness starts only loopback listeners, uses fresh synthetic credentials and
an in-memory proxy database, and stops its owned child processes before removing
their temporary runtime. It does not modify LiteLLM, monkeypatch its handlers,
call a real provider, access the deployed gateway, or change proxy source code.
The report includes harness/built-proxy hashes, dependency versions, timings,
sanitized history rows and source-verification results. Generated credentials,
raw application logs and request bodies are not saved in the report.

## Observed result — 2026-10-23

The final qualification run passed all four cases. Both stock gateway chains
cancelled promptly; neither waited for the proxy deadline.

| Route | Fake upstream socket closed after client disconnect | History observed finalized | Final status |
| --- | ---: | ---: | --- |
| Messages, direct proxy | 0.69 ms | 2.33 ms | cancelled |
| Messages, stock LiteLLM chain | 1.58 ms | 27.46 ms | cancelled |
| Responses, direct proxy | 0.76 ms | 1.37 ms | cancelled |
| Responses, stock LiteLLM chain | 1.00 ms | 26.59 ms | cancelled |

Each case made exactly one fake upstream request. All 13 pinned LiteLLM source
hashes matched before and after. The runtime was Windows loopback with LiteLLM
1.103.1, FastAPI 0.161.1, Starlette 1.9.0, Uvicorn 0.54.0, HTTPX 0.28.1 and Prisma
0.11.0. History polling adds observation latency; these numbers are not a
performance guarantee.

An initial run observed all four cancellations but failed its Windows temporary
directory cleanup because the gateway still used that directory. Child cleanup
ordering was fixed and subsequent runs exited successfully. This was a harness
cleanup issue, not a gateway cancellation failure.

This result does not establish cancellation behavior for every dependency
combination or the deployed Linux container. It also cannot establish when a
real provider stops generation or billing; it establishes only the tested
socket closure and local proxy cancellation behavior.
