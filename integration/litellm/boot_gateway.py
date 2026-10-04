"""Start the stock FastAPI application; no source or route monkey patching."""
import asyncio
import socket
import litellm
import uvicorn

litellm.telemetry = False
from litellm.proxy.proxy_server import app

listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(128)
print("LOCAL_GATEWAY_PORT=" + str(listener.getsockname()[1]), flush=True)
asyncio.run(uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="on")).serve(sockets=[listener]))
