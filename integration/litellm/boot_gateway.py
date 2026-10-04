"""Start the stock FastAPI application; no source or route monkey patching."""
import asyncio
import socket
import litellm
import uvicorn

litellm.telemetry = False
from litellm.proxy.proxy_server import app

def main():
    # Keep ownership of the ephemeral loopback listener until Uvicorn exits.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        print("LOCAL_GATEWAY_PORT=" + str(listener.getsockname()[1]), flush=True)
        asyncio.run(uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="on")).serve(sockets=[listener]))


if __name__ == "__main__":
    main()
