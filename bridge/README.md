# Bridge relay

A small, stateless-by-design relay for approved Codey Handover devices. It stores only hashed credentials and opaque encrypted payloads.

```powershell
node bridge/cli.mjs start --port 8787
```

Use HTTPS/WSS through a reverse proxy in production. The plain HTTP server is intended only for local development.
