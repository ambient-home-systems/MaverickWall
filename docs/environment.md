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

## Not environment variables

Almost everything else is a setting on a screen instead — themes, how much the
wall shows, weather, alerts, Home Assistant, block order. They belong next to
an explanation of what they do, and they can be changed by somebody standing in
the room without restarting anything.
