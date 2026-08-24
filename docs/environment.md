# Environment variables

Every one is optional. A container started with none of them works.

| Variable | Default | What it does |
|---|---|---|
| `DATA_DIR` | `/data` | Where the database, the encryption key and uploads live. **Must be absolute** — a relative path resolves against the working directory, which is how one installation silently becomes two. |
| `PORT` | `8080` | The port inside the container. Change the host side of the mapping instead unless you have a reason. |
| `BASE_URL` | `http://localhost:<port>` | The address a browser actually uses. Set it if sign-in complains about an origin, or if you are behind a reverse proxy. |
| `DISPLAY_DIR` | `/app/display` in the image | Where the wall's bundle is. Only set it if you run from a checkout in an unusual layout. |
| `NODE_OPTIONS` | `--max-old-space-size=256` | Heap cap. 256MB is comfortable for a household calendar and means a leak restarts the container rather than having the kernel pick a victim. |
| `SUPERVISOR_TOKEN` | — | Set by the Home Assistant supervisor. **Never set this yourself**: its presence is how the application knows it is running as an add-on, and it is a credential with full control of the house. |
| `TRUSTED_PROXY_SOURCE` | — (unset) | A comma-separated list of socket addresses to trust `X-Forwarded-Proto` from, when you front the box with your own TLS-terminating reverse proxy (see `docs/exposing-safely.md`). Unset means the header is ignored entirely — the ordinary direct-to-box case — so the session cookie is issued without `Secure` and sign-in can fail with a scheme mismatch behind a proxy that isn't listed here. The value has to be the address your proxy actually connects from, never a header, because a header is forgeable by anything on the same network. |
| `INGRESS_TRUST_SOURCE` | `172.30.32.2` | Only read when `SUPERVISOR_TOKEN` is set (the add-on). The supervisor's internal socket address, which is how the settings accept a Home Assistant login in place of this application's own — pinned to where the request actually came from, never to the forgeable `X-Ingress-Path` header. The boot log prints the address the first ingress request actually arrived from; if it disagrees with the default, set this to that address. |

## Not environment variables

Almost everything else is a setting on a screen instead — themes, how much the
wall shows, weather, alerts, Home Assistant, block order. They belong next to
an explanation of what they do, and they can be changed by somebody standing in
the room without restarting anything.
