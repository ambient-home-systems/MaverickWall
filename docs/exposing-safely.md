# Exposing this safely

Short version: **do not port-forward it.**

This assumes somebody will do it anyway, which is why there is no default
password, why the first account needs a code from the container log, why every
outbound request goes through an SSRF guard, and why there is in-app rate
limiting. But secure defaults are not the same as "safe on the open internet",
and this holds your family's calendar, your photographs, and — if you connected
it — a token with full control of your house.

## The good options

### Tailscale

Put the machine on a tailnet and reach it from your phone anywhere. Nothing is
exposed to the internet at all, there is no certificate to manage, and no port
forwarded.

```bash
tailscale serve --bg 8080
```

Wall displays stay on the LAN and use the local address.

### Caddy, on your own domain

If you want a real hostname and a certificate, Caddy will get one and renew it
without being asked:

```caddyfile
wall.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

Then set `BASE_URL=https://wall.example.com` so the session cookie is issued
for the address the browser actually uses. Without it, sign-in fails with
"Missing or null Origin", or succeeds and then silently forgets you.

Behind any reverse proxy, forward the client address so rate limiting counts
callers separately rather than putting every request in one bucket:

```caddyfile
wall.example.com {
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Forwarded-For {remote_host}
	}
}
```

### Home Assistant ingress

If you run the add-on, the settings are already behind Home Assistant's own
authentication and nothing needs exposing. The displays still connect on the
LAN.

## If you do it anyway

- Put it behind HTTPS. The session cookie and every calendar address you paste
  cross the network otherwise.
- Set `BASE_URL` to the public address.
- Use a long password. There is no second factor.
- Do not connect Home Assistant. The token cannot be scoped, and the blast
  radius stops being "somebody saw my calendar".
- Watch the log. Failed sign-ins are rate limited per address, and the counters
  are in memory, so a restart clears them.

## What is exposed either way

- `/healthz` needs no credential, deliberately: a monitoring check that needs
  one is a check nobody sets up. It reveals whether the process is alive and
  roughly how fresh its data is — nothing that identifies a household.
- Everything else needs a session or a display token.
