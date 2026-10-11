# WSS MTProto through ordinary Cloudflare proxy

## Scope / wire protocol

```
Desktop -> wss://x.wmc.de5.net/mtproto -> Cloudflare HTTPS proxy
        -> origin TLS reverse proxy -> CrossGram MTProto WebSocket bridge
```

This is **not** WebUI `/api`, HTTP CONNECT, MTProxy, Spectrum, or a browser
proxy. `TcpConnection` retains its existing 64-byte obfuscation preface,
AES-CTR byte-stream state, abridged MTProto framing, RSA key exchange,
authorization keys and encrypted MTProto messages. `WssSocket` replaces only
its byte I/O. WebSocket messages are binary; neither message nor frame
boundaries delimit MTProto packets. The server's `WebSocketBridge` and
`ServerConnection` auto-detect the same obfuscated abridged protocol.

Persistent integration lives in `patch.ts`, `wss-patch.ts`, injected C++ assets
and account/DC fragments. Never edit only generated upstream sources.
Qt6 WebSockets is a **required** link dependency. Windows/macOS prepare scripts
and the Linux Docker Qt superbuild initialize `qtwebsockets`, including static
builds; existing dependency caches need rebuilding when this recipe changes.
Missing Qt WebSockets is a configure error, not a silent TCP fallback.

## Import format

```json
{
  "name": "CrossGram WSS",
  "transport": "websocket",
  "websocket_url": "wss://x.wmc.de5.net/mtproto",
  "rsa_key": "REPLACE WITH THIS SERVER'S RSA-2048 PUBLIC PEM",
  "enable_special_config": false,
  "dcs": [{"id": 1}, {"id": 2}, {"id": 3}, {"id": 4}, {"id": 5}]
}
```

The above is a template, not an operational key. Generate a genuinely
importable document from an exported **public** PEM:

```sh
node scripts/wss-config.mjs server-public.pem \
  wss://x.wmc.de5.net/mtproto > crossgram-wss.json
```

Never copy the server's private RSA key to a desktop. A locally generated test
public key makes a syntactically importable configuration, but cannot
authenticate to an existing server with a different key. For a local fixture,
retain its matching private key only in the fixture's private working directory.

- Missing `transport` means legacy TCP, with unchanged IP-only `host`, `port`
  and `dcs[].ip/port` requirements. Explicit `tcp` is also accepted.
- WSS requires `enable_special_config: false`. `host`, `port`, and DC IP/port
  fields are rejected rather than accidentally used as a fallback.
- `dcs` may be omitted in WSS mode: ids 1–5 use the default URL. Explicit maps
  must contain initial DC **2**, use unique integer ids 1–1000, and be nonempty.
  Each DC may override `websocket_url`; otherwise it inherits the top-level URL.
- URLs require `wss`, a DNS hostname, an explicit nonempty absolute path,
  optional port 1–65535, and may retain an encoded query. Credentials,
  fragments (even empty), literal IPv4/IPv6, malformed escapes, backslashes,
  whitespace, bad DNS labels and unsupported schemes are rejected. URL length
  is limited to 4096 characters; JSON is limited to 1 MiB.
- Desktop uses the URL host for DNS, SNI and certificate verification. It never
  pins an edge IP or disables TLS verification. Requires TLS 1.2 or later.
- Ordinary Cloudflare proxy requires a supported **edge** HTTPS port; use the
  default 443. A valid desktop URL port is not necessarily a valid Cloudflare
  edge port. An Origin Rule changes the destination port, not the transport
  protocol and not the URL seen by Desktop.

## Account isolation / failure policy

Each account's JSON remains at `tdata/<account-hash>/server-switch.json`.
Transport selection and DC URL maps belong to that account's `DcOptions`, never
process-global state. WSS accounts ignore global Telegram proxies and IPv4/
IPv6/TCP/HTTP racing switches: they create only WSS attempts. Official and
legacy TCP accounts retain upstream routing/proxy behavior. Server-provided
`help.getConfig` cannot overwrite immutable custom endpoints. Media sessions
use the same explicit DC map; unmapped migrations and CDN sessions fail closed
instead of dialing official endpoints. Special configuration is disabled.

A semantic endpoint/key/transport hash is appended **inside the existing
encrypted authorization record**, alongside its keys. JSON name/whitespace
changes do not change this binding. Endpoint, RSA, transport or URL changes
(including query changes) do. Changing servers in the sign-in UI clears current
and pending-destruction keys, persists the cleared record, then opens the new
origin. Changing servers after sign-in is refused before disk mutation.

On startup, malformed stored JSON or an existing key/identity mismatch leaves
**that account offline before creating any transport connections**; other
accounts are unaffected, and there is no official-server fallback. The original
binding is preserved and a diagnostic is logged (no dedicated recovery dialog).
Restore the original JSON from backup and restart, or use a fresh account directory. Do not
solve it by copying authorization files or deleting the binding. Deleting a
WSS JSON with bound keys also fails closed. Append-only storage stays readable
by older clients, but downgrading loses the new safety guarantees.

Legacy official/TCP authorization records have no binding: first upgrade
trusts their existing configuration and binds it. Legacy keys cannot first
appear under WSS. Thus migrate an already-signed-in TCP account by adding a
**new account**, not by editing its JSON. There is deliberately no automatic
TCP-to-WSS key migration. This binding is not protection against a local
attacker who can edit/decrypt account storage.

## Bounds, timeouts, reconnects and diagnostics

- Application send backlog plus Qt socket backlog: 8 MiB payload admission cap;
  output is drained in ordered <=256 KiB binary messages. Excess aborts rather
  than silently discarding bytes or letting ciphertext grow without bound.
- Input queue: 8 MiB, with Qt incoming frame/message caps of 8 MiB. Qt internal
  buffering is separately bounded; the existing MTProto parser retains its
  own upstream packet bound (64 MiB). These are separate allocations, not a
  claim that total process memory is only 8 MiB.
- Connect/TLS/upgrade deadline: 15 seconds, also subject to upstream's shorter
  connection deadlines. Stalled output: 30 seconds without write progress.
  Receive liveness and encrypted MTProto ping/retry remain SessionPrivate's
  upstream timers. Retrying creates a new socket and obfuscation state; queued
  ciphertext is never replayed on a different connection.
- Reconnect uses existing upstream backoff (up to 64 seconds), including
  Cloudflare restarts/connection closure. Neither TLS nor authentication errors
  trigger a downgrade. Auth/RSA/DC protocol failures remain MTProto errors,
  distinct from socket failures.
- Stable production log categories include `dns`, `tls-certificate`,
  `tls-handshake`, `connect-refused`, `network-timeout`, `upgrade-or-protocol`,
  `network-or-upgrade`, `non-binary`, `send-overflow`, `receive-overflow`,
  `short-write`, `connect-timeout`, `write-timeout`, `mtproto-timeout` and
  `unmapped-or-cdn-dc`. Qt does not always distinguish HTTP rejection from other
  handshake/protocol failures. URLs/query tokens and raw server error text are
  deliberately omitted. Inspect reverse-proxy logs for HTTP status details.

## Server configuration (instructions only; not applied)

Source inspected: `std-microblock/crossgram` at
`4bb55bc00c17a389dbdae7953dd57ae3a7fea9ae`:
`packages/mtproto/src/service.ts`, `transport/ws-server.ts`,
`transport/server-connection.ts`, `transport/server-obfuscation.ts`.

**Preferred:** keep MTProto TCP 4430 and management listener
`127.0.0.1:3140` unchanged. Add `wsPath: /mtproto` to the existing MTProto plugin
configuration in `app.yml`. It mounts a separate route on Cordis's shared HTTP
server; `/api` stays management RPC and must never be substituted.

```yaml
# Merge these fields into the EXISTING @mtproto-relay/mtproto plugin config.
# Do not regenerate or replace rsaKeyPath/authKeyStorePath on a real instance.
config:
  port: 4430
  host: 0.0.0.0
  rsaKeyPath: ./data/rsa-key.json
  authKeyStorePath: ./data/auth-keys.json
  wsPath: /mtproto
```

If a shared HTTP server is unavailable, `wsPort: 4431` creates a separate
**plaintext** WebSocket listener. At the inspected revision it accepts every
path, so restrict `/mtproto` in the reverse proxy. Binding follows the MTProto
`host` setting; do not expose this plaintext listener publicly. `wsPath` and
`wsPort` can coexist, but are not necessary together.

Example origin nginx **TLS** virtual host snippet (operator must select an
available port, paths, certificate and existing management policy):

```nginx
server {
    listen 8443 ssl;
    server_name x.wmc.de5.net;
    ssl_certificate     /operator/managed/fullchain.pem;
    ssl_certificate_key /operator/managed/private-key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location = /mtproto {
        proxy_pass http://127.0.0.1:3140; # shared wsPath route, not /api
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
    # Do not proxy management paths from this transport-only vhost.
    location / { return 404; }
}
```

For a dedicated wsPort, change only `proxy_pass` to
`http://127.0.0.1:4431`; the exact-path restriction remains. Set suitable
firewall/connection limits independently. Do not point an HTTPS origin rule
directly to plaintext 3140/4431 or MTProto TCP 4430: port rewriting does not add
TLS or convert MTProto into HTTP. Keep existing management protections intact;
this snippet is an isolated transport-only vhost, not a replacement admin UI.

## Cloudflare operator checklist (instructions only; not applied)

1. Proxy the DNS record for `x.wmc.de5.net` (orange cloud) to the actual origin.
2. Enable WebSockets. Use client URL `wss://x.wmc.de5.net/mtproto` on edge 443.
3. Use Full (strict); install an origin certificate valid for the host.
4. If using the example TLS origin listener, create a destination-port Origin
   Rule for host `x.wmc.de5.net` **and exact path `/mtproto`**, port 8443. Keep
   Host/SNI matching the origin certificate; do not rewrite the path to `/api`.
5. Do not put an interactive Access login/challenge on the MTProto transport
   route: Desktop cannot complete browser challenges or management SSO. Keep
   protection of management routes unchanged. If organizational policy requires
   interactive protection, this client cannot connect; do not broadly disable
   the policy. Add narrowly scoped transport rate/connection controls instead.
6. Verify the public TLS chain, exact route and HTTP 101 upgrade, then test a
   disposable account's RSA handshake/login manually. A 101 is not proof of
   MTProto authentication. Cloudflare may close established WebSockets; client
   reconnection is expected.

Authoritative references (checked 2026-10-11):
[WebSockets](https://developers.cloudflare.com/network/websockets/),
[Origin Rule settings](https://developers.cloudflare.com/rules/origin-rules/features/),
[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/),
[Qt QWebSocket](https://doc.qt.io/qt-6/qwebsocket.html).

## Reproducible verification

```sh
yarn install --immutable
yarn typecheck
yarn build
yarn test
yarn test:wss-native
# Native test needs CMake, Ninja, Qt6 Core/Network/WebSockets, OpenSSL CLI,
# a C++20 compiler, and localhost.localdomain resolving to IPv6 loopback.
```

Native tests compile the **production** URL validator, configuration parser and
WSS stream. They run a local trusted TLS WebSocket fixture and cover URL/path/
query handling, fragmented and coalesced byte streams, send ordering, text
rejection, send/receive bounds, timeout, remote close and untrusted certificates.
Configuration tests inject a public-key validation callback; actual Desktop
RSA parsing and the complete RSA/DH authorization flow are not established by
that parser test. Binding-policy unit tests do not replace a full Desktop
storage/restart test. Structural tests check integration and repeated patching.

With a local CrossGram checkout and its test dependencies installed, run:

```sh
scripts/test-wss-server.sh /path/to/crossgram
```

This creates and removes a temporary local test file, runs an ephemeral real
CrossGram service behind a loopback TLS pipe, and drives it using the production
Qt WSS stream. The C++ probe sends a split obfuscated/abridged `req_pq` and
checks `resPQ`, its nonce, and the server RSA fingerprint. It is **pre-auth**
interoperability only, not a full RSA/DH/login or Cloudflare test. The test never
executes chat operations. The server checkout is not deployed or reconfigured.
CI's existing upstream patch matrix additionally exercises supported forks;
`wss-native.yml` adds Linux Qt compilation/runtime checks, not a full Desktop
release build. Record these statuses separately in review.
