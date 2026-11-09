# Headless server

The Fastify example in [`examples/server`](../../examples/server/README.md) runs the engine without a UI: a fan's message arrives over HTTP, Juno's reply bubbles stream back as server-sent events, a human can take the chat over and hand it back, and every event is posted to a signed webhook. Its README has the run steps and the endpoints.

Data flow: [server.html](server.html).
