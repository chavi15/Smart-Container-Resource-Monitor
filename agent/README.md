# CRMTR Agent

Deploy this on any machine you want to monitor remotely.

## Run directly
```bash
node agent.js
```

## Run as Docker container (simulates remote machine on one laptop)
```bash
docker build -t crmtr-agent .
docker run -d \
  --name crmtr-agent \
  -p 9101:9101 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  crmtr-agent
```

## Test
```bash
curl http://localhost:9101/health
curl http://localhost:9101/stats
```

## Add to CRMTR server.js
```js
const AGENTS = [
  { name: 'localhost',  url: null },
  { name: 'This-Agent', url: 'http://MACHINE_IP:9101' },
];
```
