# Nanoscope

A desktop MQTT dashboard for browsing topics, inspecting payloads, monitoring
NanoMQ clients, and publishing test messages. React/TypeScript provides the UI;
a Go service records a rolling history in SQLite.

## Start developing

Prerequisites: Node (use `app/.nvmrc`, currently 20.20.2), npm, Go 1.23 or
compatible toolchain, and a reachable MQTT broker. NanoMQ's HTTP API supplies
additional client and broker metrics. No broker is bundled with this repo.

Create your private configuration once:

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env` with your broker address and NanoMQ HTTP API credentials. It is
ignored by Git. Both projects load it automatically when started as shown below.
Exported environment variables override the file; backend flags override both.
Leave the API credentials empty if metadata authentication is not needed.
Never put secrets in `VITE_*` variables, which Vite exposes to browser code.

In one terminal, start the backend using your local configuration:

```sh
cd server
go run .
```

In another terminal:

```sh
cd app
nvm use
npm ci
npm run dev
```

Open <http://localhost:5180>. Vite proxies `/api` to the backend at
`http://127.0.0.1:8090`. The backend uses `MQTT_HOST` from your environment or `.env`, falling back to
`127.0.0.1:1883`; it stores `nanoscope.db` relative to its working directory.
History accumulates while the backend runs, including when the browser is closed.

## Preview the frontend only

You can preview the UI without running the Go backend. From the repository root:

```sh
cd app
nvm use
npm ci # first time, or after dependencies change
npm run dev
```

Open <http://localhost:5180> to view the layout. Without the backend, message
tables remain empty and the UI shows a disconnected state; there is no mock data.

To receive real traffic without the backend, open
<http://localhost:5180/?mode=live>. Vite reads the broker settings from the root
`.env` described above and bridges the browser connection to the MQTT broker.
This mode requires a reachable broker and has no persisted history.
See [frontend documentation](app/README.md) for details.

## Checks

Run from `app/`: `npm run build` and `npm run lint`.
Run from `server/`: `go test ./...`.
There is no frontend test script configured.

## Serve a production build

```sh
cd app
npm run build
cd ../server
go build -o nanoscope .
./nanoscope -static ../app/dist
```

Open <http://localhost:8090>. Keep the binary, built assets, and database on the
deployment host. Vite's development proxies and MQTT bridge are not part of the
static build. Vite reads the root `.env` when building; credentials stay out of browser assets.
Run the backend from `server/` as shown, or place `.env` in its working directory
on the deployment host. Keep `.env` outside the directory served as static files.

## Where to look

- [AGENTS.md](AGENTS.md): architecture, change guidance, and important invariants.
- [app/README.md](app/README.md): frontend and direct MQTT mode.
- [server/README.md](server/README.md): backend flags, storage, and HTTP API.
- [design/README.md](design/README.md): visual specification, with an HTML prototype
  and screenshots in `design/`. The prototype uses simulated data; the app uses real traffic.
