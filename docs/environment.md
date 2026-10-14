# Environment variables

Every one is optional. A container started with none of them works.

| Variable | Default | What it does |
|---|---|---|
| `DATA_DIR` | `/data` | Where the database, the encryption key and uploads live. **Must be absolute** — a relative path resolves against the working directory, which is how one installation silently becomes two. |
| `PORT` | `8080` | The port inside the container. Change the host side of the mapping instead unless you have a reason. |
| `BASE_URL` | `http://localhost:<port>` | The address a browser actually uses. Set it if sign-in complains about an origin, or if you are behind a reverse proxy. |
| `DISPLAY_DIR` | `/app/display` in the image | Where the wall's bundle is. Only set it if you run from a checkout in an unusual layout. |
| `FONTS_DIR`, `EMOJI_DIR`, `WALLPAPERS_DIR`, `METEOCONS_DIR` | `/app/fonts`, `/app/emoji`, `/app/wallpapers` and `/app/meteocons` in the image | Where the bundled fonts, emoji, wallpapers and weather pictures are. Like `DISPLAY_DIR`, only for a checkout in an unusual layout. A missing directory is a line in the boot log and the pictures in it are not drawn — the server still starts. |
| `TZ` | — (unset, so UTC) | The container's own timezone. Only the first-run wizard reads it: when it is set, the timezone step offers that zone as the one detected. The household's timezone is a setting on **System**, and this does not change it afterwards. |
| `MDNS_DISABLE` | — (unset) | Any value turns off the announcement on your local network that lets the Android TV app find the server without anybody typing its address. Walls can still be paired by address. On the add-on, the `mdns` option sets it. |
| `MDNS_NAME` | `Maverick Wall` | The name that announcement uses, if two installations share a network. |
| `MW_VERSION` | Set by the image | The release, written in when the image is built. **Do not set it yourself.** A build without it reports its version with `-dev` on the end, which is also what turns the update check off. |
| `NODE_OPTIONS` | `--max-old-space-size=256` | Heap cap. 256MB is comfortable for a household calendar and means a leak restarts the container rather than having the kernel pick a victim. |
| `SUPERVISOR_TOKEN` | — | Set by the Home Assistant supervisor. **Never set this yourself**: its presence is how the application knows it is running as an add-on, and it is a credential with full control of the house. |
| `TRUSTED_PROXY_SOURCE` | — (unset) | A comma-separated list of socket addresses to trust `X-Forwarded-Proto` from, when you front the box with your own TLS-terminating reverse proxy (see `docs/exposing-safely.md`). Unset means the header is ignored entirely — the ordinary direct-to-box case — so the session cookie is issued without `Secure` and sign-in can fail with a scheme mismatch behind a proxy that isn't listed here. The value has to be the address your proxy actually connects from, never a header, because a header is forgeable by anything on the same network. |
| `INGRESS_TRUST_SOURCE` | `172.30.32.2` | Only read when `SUPERVISOR_TOKEN` is set (the add-on). The supervisor's internal socket address, which is how the settings accept a Home Assistant login in place of this application's own — pinned to where the request actually came from, never to the forgeable `X-Ingress-Path` header. The boot log prints the address the first ingress request actually arrived from; if it disagrees with the default, set this to that address. |

## Not environment variables

Almost everything else is a setting on a screen instead — themes, how much the
wall shows, weather, alerts, Home Assistant, layouts. They belong next to
an explanation of what they do, and they can be changed by somebody standing in
the room without restarting anything.
