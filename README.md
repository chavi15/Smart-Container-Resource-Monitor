# CRMTR — Container Resource Monitor

> A real-time Docker container monitoring dashboard. Connects directly to your local Docker daemon and displays live CPU, memory, network and disk metrics for every running container — with ML-based prediction, health scoring, a CPU heatmap, network topology mapping, and full container inspection.

![Status](https://img.shields.io/badge/status-working-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D14-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Dependencies](https://img.shields.io/badge/npm%20dependencies-0-lightgrey)
![Docker](https://img.shields.io/badge/requires-Docker%20Desktop-blue)

---

## Table of Contents

- [What is this?](#what-is-this)
- [System Workflow](#system-workflow)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [All Tabs Explained](#all-tabs-explained)
- [Multi-Host Monitoring](#multi-host-monitoring)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Architecture & Technical Design](#architecture--technical-design)
- [Future Roadmap](#future-roadmap)

---

## What is this?

CRMTR is a browser-based container monitoring dashboard inspired by production tools like **Grafana**, **Portainer**, and **Netdata**. It talks directly to Docker on your machine through shell commands and exposes everything through a clean dashboard that updates every 2 seconds with no page reload.

It is built entirely without a frontend framework, without a database, and with zero npm dependencies. The backend is a single 260-line Node.js file.

---

## System Workflow

```mermaid
flowchart TD
    A([Browser opens localhost:3000]) --> B[server.js serves static files]
    B --> C[app.js initialises in browser]
    C --> D[/api/docker-check — verify daemon]
    D --> E[setInterval doTick every 2000ms]

    E --> F[fetch /api/containers]
    F --> G[server runs: docker stats --no-stream]
    G --> H[parse NDJSON → containers array]
    H --> I[push into S and H state objects]
    I --> J[buildAlerts — check 6 thresholds]

    J --> K[renderSidebar + renderMiniStats]
    K --> L[tickCharts — push to Chart.js]
    L --> M{Active panel?}

    M -- Overview    --> N[metric cards, sparklines, suggestions]
    M -- Live Charts --> O[4 line charts + fleet bar]
    M -- Containers  --> P[progress bars, limits modal]
    M -- Alerts      --> Q[alert list + rules table]
    M -- Prediction  --> R[OLS + EMA charts + history table]
    M -- Health      --> S[tile grid + lifecycle events]
    M -- Heatmap     --> T[time x container CPU grid]
    M -- Network     --> U[docker inspect → topology map]
    M -- Inspector   --> V[docker inspect → full detail panel]

    N & O & P & Q & R & S & T --> E
```

---

## Features

| Tab | Feature | Description |
|---|---|---|
| Overview | Fleet metrics | Avg CPU, avg memory, total network I/O, total disk I/O across all containers |
| Overview | Sparklines | 30-point mini bar graphs with red spike highlighting above 85% |
| Overview | Alert feed | Latest 3 alerts with severity badges |
| Overview | Suggestions | Rule-based engine recommending scale/optimise/downsize actions |
| Live Charts | Line charts | CPU %, Memory %, Network MB/s, Disk MB/s per container — auto-refresh 2s |
| Live Charts | Fleet bar | CPU comparison across all containers simultaneously |
| Containers | Progress bars | Colour-coded bars — green→yellow→red as metrics cross thresholds |
| Containers | Limits editor | Modal to apply new CPU cores or memory limit via `docker update` |
| Alerts | Alert engine | 6 configurable threshold rules, badge count in tab header |
| Prediction | OLS model | Ordinary least squares linear regression — 30-second CPU forecast |
| Prediction | EMA model | Exponential moving average — faster response to spikes |
| Prediction | Model comparison | Side-by-side R² confidence, slope, and delta cards |
| Prediction | History table | Timestamped log of all collected metrics with both model predictions |
| **Health** | Scorecard tiles | Colour-coded tile per container — HEALTHY / WARNING / CRITICAL |
| **Health** | Trend arrows | ↑ ↗ → ↓ per container based on OLS slope |
| **Health** | Lifecycle events | Real-time stream of container start / stop / die / restart events |
| **Heatmap** | CPU heatmap | Time × container grid coloured by CPU intensity — spot patterns instantly |
| **Network** | Topology map | Real Docker network layout from `docker inspect` — IPs, MACs, ports |
| **Inspector** | Full detail | Image, creation time, limits, ports, volumes, networks, env vars (filtered) |
| Topbar | CSV export | Download all collected metrics as a timestamped CSV file |
| Topbar | Pause / Resume | Freeze all polling and rendering without losing history |

---

## Tech Stack

### Frontend
| Technology | Version | Purpose |
|---|---|---|
| HTML5 | — | Page shell, 9 panel `<div>` elements, tab structure |
| CSS3 | — | Dark theme, CSS custom properties, Flexbox, Grid |
| Vanilla JavaScript | ES2020 | All app logic — no framework, no build step |
| Chart.js | 4.4.1 (CDN) | Line charts, bar chart, scatter plot |
| Space Mono | Google Fonts | Monospace font for all numbers and labels |
| Syne | Google Fonts | Sans-serif font for body text |

### Backend
| Technology | Purpose |
|---|---|
| Node.js | Runtime — built-in `http`, `fs`, `path`, `child_process` modules only |
| `child_process.exec` | Runs all Docker CLI commands and captures their output |
| `http.createServer` | HTTP server for static files and API endpoints |
| `new URL()` | WHATWG URL parsing — replaces deprecated `url.parse()` |

### Container Runtime
| Command | What it does |
|---|---|
| `docker stats --no-stream --format "{{json .}}"` | Snapshot of all container metrics as NDJSON |
| `docker events --since X --until Y` | Container lifecycle events in a time window |
| `docker inspect containerName` | Full container configuration as JSON |
| `docker update --cpus X --memory Y` | Apply resource limits to a running container |
| `docker info` | Check Docker daemon version and availability |

### ML Models
| Model | Formula | Use case |
|---|---|---|
| OLS Linear Regression | ŷ = β₀ + β₁x | Steady, consistent trends — high R² = trustworthy |
| Exponential Moving Average | EMAₜ = α·xₜ + (1−α)·EMAₜ₋₁ | Volatile/spiky metrics — α=0.3 |

Both implemented from scratch in ~30 lines of JavaScript each. No external ML library.

---

## Project Structure

```
crmtr/
├── index.html        # HTML shell — topbar, 9 tab panels, sidebar
├── style.css         # Full dark theme — CSS variables, all component styles
├── app.js            # All client JS — metrics, charts, ML, rendering (~740 lines)
├── server.js         # Node.js server — static files + 6 API endpoints (~260 lines)
├── agent/
│   ├── agent.js      # Remote agent — deploy on any machine to monitor it
│   └── Dockerfile    # Build agent as a Docker container
├── package.json      # Project metadata — zero dependencies
├── .gitignore        # Ignores .env, node_modules, OS files
└── README.md         # This file
```

---

## Quick Start

### Requirements
- **Node.js 14+** — check: `node --version`
- **Docker Desktop** — must be running
- A modern browser

### Run it

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/crmtr.git
cd crmtr

# 2. Start some containers to monitor
docker run -d --name web-server nginx
docker run -d --name app-server node:18 node -e "setInterval(()=>{let x=0;for(let i=0;i<4000000;i++)x+=Math.sqrt(i);},150);"
docker run -d --name database -e POSTGRES_PASSWORD=secret postgres:15
docker run -d --name cache redis:7

# 3. Start the dashboard
node server.js

# 4. Open http://localhost:3000
```

Containers appear in the sidebar within 2 seconds. No configuration needed.

---

## All Tabs Explained

### Overview
Fleet-wide summary cards, sparkline history graphs, live alerts, and rule-based optimization suggestions. The suggestion engine checks every tick — CPU above 80% triggers a scale suggestion, CPU below 5% triggers a downsize suggestion, memory above 300MB triggers a memory optimisation suggestion.

### Live Charts
Four Chart.js line graphs auto-updating every 2 seconds for the selected container. Animations are disabled intentionally — at 2-second intervals, animation causes the line to lag behind the data. This is how Grafana works. A fleet bar chart at the bottom compares CPU across all containers simultaneously.

### Containers
A card per container with colour-coded progress bars. Click **✎ limits** to open a modal and apply a new CPU or memory limit live using `docker update`. The limit applies instantly without restarting the container — Docker updates the Linux cgroup limits directly.

### Alerts
Six configurable threshold rules checked on every tick. Alerts show container name, metric, value, and timestamp. The tab badge count reflects critical alerts only.

```
CPU > 85%      → CRITICAL
CPU > 70%      → WARNING
Memory > 88%   → CRITICAL
Memory > 75%   → WARNING
Network > 80   → WARNING
CPU < 5%       → IDLE
```

### Prediction
Two ML models run simultaneously on each container's CPU history:

**Model 1 — OLS Linear Regression:** Computes the slope of the best-fit line through all history using the least-squares closed-form solution. Predicts 15 ticks (30 seconds) ahead. R² confidence score shows how linear the trend is.

**Model 2 — EMA:** Weights recent values more heavily using decay factor α=0.3. Reacts faster to sudden spikes. Confidence derived from Mean Absolute Error.

A ✓ agree badge appears when both models are within 5% of each other. A ⚡ diverge badge warns when they differ — usually indicating a recent sudden change that OLS hasn't caught up to yet.

### Health
War-room scorecard view. One tile per container showing status, live CPU with a trend arrow, memory fill bar, PIDs, and network/disk summary. Below the tiles is a live lifecycle event stream — every container start, stop, die, restart, and kill event appears here within 2 seconds.

### Heatmap
Time × container CPU intensity grid. Each row is a container, each column is one 2-second sample (up to 120 columns = 4 minutes of history). Colour ranges from dark blue (low) through yellow (medium) to red (high). Hover any cell for the exact timestamp and CPU value. Reveals patterns invisible in line charts — a column of red across all containers indicates a fleet-wide spike event.

### Network
Calls `docker inspect` on every running container in parallel, extracts `NetworkSettings.Networks`, and groups containers by network membership. Each container card shows its IP address, MAC address, gateway, and exposed ports. Shows the real Docker network topology as it exists.

### Inspector
Full `docker inspect` output parsed and presented in a two-column panel: identity (name, image, hostname, creation date, start time, status, restart count), resource configuration (CPU limit, memory limit, restart policy), live metrics from the current tick, ports, network memberships with IPs, volume mounts with source → destination paths, and environment variables with passwords/keys/tokens filtered out automatically.

---

## Multi-Host Monitoring

To monitor containers on other machines, deploy the agent:

```bash
# On each remote machine
cd agent/
node agent.js
# Exposes http://MACHINE_IP:9101/stats
```

Or run it as a Docker container (simulates a remote machine on one laptop):

```bash
cd agent/
docker build -t crmtr-agent .
docker run -d \
  --name crmtr-agent \
  -p 9101:9101 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  crmtr-agent
```

Then add the agent to `server.js`:

```js
const AGENTS = [
  { name: 'localhost',   url: null },
  { name: 'Remote-PC',  url: 'http://192.168.1.55:9101' },
];
```

The dashboard merges all containers from all agents into one view.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/containers` | All running container metrics from `docker stats` |
| GET | `/api/docker-check` | Docker daemon availability and version |
| GET | `/api/logs?name=X&lines=N` | Last N log lines from container X |
| GET | `/api/events` | Container lifecycle events since last poll |
| GET | `/api/inspect?name=X` | Full `docker inspect` output for container X |
| POST | `/api/limits` | Apply CPU/memory limits via `docker update` |

All endpoints return JSON. All support CORS.

---

## Configuration

Edit the `CONFIG` object at the top of `app.js`:

```javascript
const CONFIG = {
  tickMs:  2000,   // polling interval in milliseconds
  histMax: 120,    // history points stored per container (120 × 2s = 4 minutes)
  sparkLen: 30,    // bars shown in overview sparklines
  thresholds: {
    cpuCrit:  85,  // CPU % → CRITICAL alert
    cpuWarn:  70,  // CPU % → WARNING alert
    memCrit:  88,  // Memory % → CRITICAL alert
    memWarn:  75,  // Memory % → WARNING alert
    netWarn:  80,  // Network MB/s → WARNING alert
    idle:      5,  // CPU % below this → IDLE suggestion
  },
};
```

Change the server port in `server.js`:

```javascript
const PORT = 3000;
```

---

## Architecture & Technical Design

### Data flow
Every 2 seconds `doTick()` fires. It calls `fetch('/api/containers')` which triggers `docker stats --no-stream` on the server. The `--no-stream` flag takes one snapshot and exits — ideal for polling. The server parses the NDJSON output (one JSON object per line) into a typed array, normalising all string values like `"0.57%"` and `"8.67MiB / 2GiB"` into plain numbers. The browser stores metrics in two objects — `S` (current state, one entry per container) and `H` (history arrays, up to `histMax` entries per container).

### Alert engine
`buildAlerts()` runs synchronously on every tick. It iterates all containers and checks each metric against all 6 threshold rules, producing a fresh `alerts` array. The tab badge updates immediately. No debouncing — every tick is a clean re-evaluation.

### Chart performance
`animation: false` is set on all Chart.js instances. This is a deliberate production decision — at 2-second intervals, any CSS animation would cause the visible line to lag behind the actual data. `chart.update('none')` pushes data to the canvas instantly without triggering the animation pipeline. Charts are constructed once at startup and persist in memory — only their data arrays are mutated each tick.

### OLS Linear Regression
```
slope  = Σ(xᵢ − x̄)(yᵢ − ȳ) / Σ(xᵢ − x̄)²
ŷ      = lastValue + slope × 15    (15 ticks × 2s = 30 seconds ahead)
R²     = 1 − SS_residual / SS_total
```

### Exponential Moving Average
```
EMAₜ = α × xₜ + (1 − α) × EMAₜ₋₁     (α = 0.3)
forecast slope = (EMA[n-1] − EMA[n-5]) / 4
ŷ = EMA[n] + forecast_slope × 15
confidence = 100 − (MAE × 2)
```

### DOM rendering strategy
Only the currently visible panel re-renders each tick. A container grid with 8 cards and 4 progress bars each is expensive to rebuild 30 times per minute when you're not looking at it. The tick loop checks `document.querySelector('.panel.active')` and calls only the relevant render function.

### Limits editor modal
Applies limits using `docker update --cpus X --memory Y containerName`. Docker translates this into cgroup updates on the host kernel — the `cpu.cfs_quota_us` file for CPU limits and `memory.limit_in_bytes` for memory. The container keeps running; only its kernel-enforced resource ceiling changes.

---

## Future Roadmap

- **WebSockets** — push metrics from server to browser instead of polling, reducing latency to near-zero
- **Persistent storage** — SQLite database to retain metric history across server restarts
- **Multi-host production** — full agent model with TLS authentication between agents and server
- **Kubernetes support** — replace `docker stats` with the Kubernetes Metrics API for pod-level monitoring
- **Anomaly detection** — Z-score based alerting that fires when a metric deviates more than 2 standard deviations from its rolling mean, rather than fixed thresholds
- **Alert webhooks** — POST to Slack, Discord, or PagerDuty when a critical alert fires
- **User authentication** — login page so the dashboard can be deployed on a server safely
- **Docker Compose grouping** — group containers by their Compose project/service name
- **Container restart button** — `docker restart containerName` with a confirmation prompt in the UI
- **Log search** — full-text search across all container logs
- **Custom alert rules** — UI to add your own threshold rules saved to a JSON file

---

## License

MIT — free to use, modify, and distribute.

*Built with vanilla JS, Chart.js 4.4, Node.js, Space Mono and Syne from Google Fonts.*
