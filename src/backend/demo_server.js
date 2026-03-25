/**
 * Garra -- Demo Server
 * ====================
 * A standalone Express.js server that demonstrates the full Garra marketplace
 * without any blockchain or OpenClaw connection.
 *
 * Run:  node demo_server.js
 * Port: 4000
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 4000;

// ─────────────────────────────────────────────────────────────
//  In-memory stores
// ─────────────────────────────────────────────────────────────

const agents = new Map();
const jobs = new Map();
const hireEvents = []; // agent-to-agent hiring ledger
const activityFeed = [];
const withdrawals = new Map(); // address -> pending balance (wei string)
const MAX_FEED = 500;

let nextAgentId = 1;
let nextJobId = 1;

function uid() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

function pushActivity(type, data) {
  const event = { id: uid(), type, timestamp: now(), data };
  activityFeed.unshift(event);
  if (activityFeed.length > MAX_FEED) activityFeed.pop();
  broadcastWs({ kind: "activity", payload: event });
  return event;
}

// ─────────────────────────────────────────────────────────────
//  Seed data
// ─────────────────────────────────────────────────────────────

function seed() {
  const seedAgents = [
    {
      name: "Polyglot Translator",
      owner: "0xABc1230000000000000000000000000000000001",
      capabilities: ["translation", "localization", "content-writing"],
      metadataURI: "ipfs://QmTranslator",
      pricePerTask: "50000000000000000", // 0.05 ETH
      totalJobsCompleted: 47,
      ratingSum: 218,
      ratingCount: 47,
      active: true,
    },
    {
      name: "DataHarvest Scraper",
      owner: "0xABc1230000000000000000000000000000000002",
      capabilities: ["web-scraping", "data-extraction", "api-integration"],
      metadataURI: "ipfs://QmScraper",
      pricePerTask: "30000000000000000", // 0.03 ETH
      totalJobsCompleted: 112,
      ratingSum: 504,
      ratingCount: 112,
      active: true,
    },
    {
      name: "Sentinel Auditor",
      owner: "0xABc1230000000000000000000000000000000003",
      capabilities: ["security-audit", "code-review", "vulnerability-scan"],
      metadataURI: "ipfs://QmAuditor",
      pricePerTask: "200000000000000000", // 0.2 ETH
      totalJobsCompleted: 23,
      ratingSum: 110,
      ratingCount: 23,
      active: true,
    },
    {
      name: "PixelForge Designer",
      owner: "0xABc1230000000000000000000000000000000004",
      capabilities: ["image-generation", "ui-design", "brand-identity"],
      metadataURI: "ipfs://QmDesigner",
      pricePerTask: "80000000000000000", // 0.08 ETH
      totalJobsCompleted: 65,
      ratingSum: 299,
      ratingCount: 65,
      active: true,
    },
    {
      name: "QubitAnalytics",
      owner: "0xABc1230000000000000000000000000000000005",
      capabilities: ["data-analysis", "sentiment-analysis", "market-research"],
      metadataURI: "ipfs://QmAnalytics",
      pricePerTask: "60000000000000000", // 0.06 ETH
      totalJobsCompleted: 89,
      ratingSum: 410,
      ratingCount: 89,
      active: true,
    },
    {
      name: "CodeWeaver Assistant",
      owner: "0xABc1230000000000000000000000000000000006",
      capabilities: ["code-generation", "debugging", "documentation"],
      metadataURI: "ipfs://QmCodeWeaver",
      pricePerTask: "100000000000000000", // 0.1 ETH
      totalJobsCompleted: 34,
      ratingSum: 157,
      ratingCount: 34,
      active: true,
    },
  ];

  for (const a of seedAgents) {
    const id = nextAgentId++;
    agents.set(id, {
      id,
      ...a,
      ratingAvg: a.ratingCount > 0 ? +(a.ratingSum / a.ratingCount).toFixed(2) : 0,
      registeredAt: now() - Math.floor(Math.random() * 30 * 86400000),
    });
  }

  // Job 1: Open (not yet assigned)
  const job1Id = nextJobId++;
  jobs.set(job1Id, {
    id: job1Id,
    client: "0xCLIENT0000000000000000000000000000000001",
    budget: "150000000000000000", // 0.15 ETH
    description: "Translate investor pitch deck into Spanish, French, and German",
    requiredCapabilities: ["translation", "localization"],
    assignedAgentId: 0,
    status: "Open",
    createdAt: now() - 3600000,
    completedAt: 0,
    clientRating: 0,
    escrow: "150000000000000000",
  });

  // Job 2: InProgress (assigned and started)
  const job2Id = nextJobId++;
  jobs.set(job2Id, {
    id: job2Id,
    client: "0xCLIENT0000000000000000000000000000000002",
    budget: "200000000000000000", // 0.2 ETH
    description: "Full security audit of DeFi smart contract suite (3 contracts)",
    requiredCapabilities: ["security-audit", "code-review"],
    assignedAgentId: 3, // Sentinel Auditor
    status: "InProgress",
    createdAt: now() - 86400000,
    completedAt: 0,
    clientRating: 0,
    escrow: "200000000000000000",
  });

  // Job 3: Completed
  const job3Id = nextJobId++;
  jobs.set(job3Id, {
    id: job3Id,
    client: "0xCLIENT0000000000000000000000000000000003",
    budget: "60000000000000000", // 0.06 ETH
    description: "Analyze sentiment across 10,000 crypto Twitter posts for market report",
    requiredCapabilities: ["sentiment-analysis", "data-analysis"],
    assignedAgentId: 5, // QubitAnalytics
    status: "Completed",
    createdAt: now() - 172800000,
    completedAt: now() - 86400000,
    clientRating: 5,
    escrow: "0",
  });

  // Seed an agent-to-agent hire: Sentinel Auditor hired CodeWeaver for the audit
  hireEvents.push({
    id: uid(),
    hirerAgentId: 3,
    hiredAgentId: 6,
    jobId: job2Id,
    timestamp: now() - 43200000,
  });

  // Seed pending withdrawal balances
  withdrawals.set("0xABc1230000000000000000000000000000000005", "57000000000000000");

  console.log(
    `[Seed] ${agents.size} agents, ${jobs.size} jobs, ${hireEvents.length} hire events loaded`
  );
}

// ─────────────────────────────────────────────────────────────
//  Express + WebSocket
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });
const wsClients = new Set();

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
  ws.send(JSON.stringify({ kind: "connected", timestamp: now() }));
});

function broadcastWs(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ─────────────────────────────────────────────────────────────
//  Routes: Health
// ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    mode: "demo",
    agents: agents.size,
    jobs: jobs.size,
    timestamp: now(),
  });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Agents
// ─────────────────────────────────────────────────────────────

app.get("/api/agents", (_req, res) => {
  const capFilter = _req.query.capability;
  const activeOnly = _req.query.active !== "false";
  let results = [...agents.values()];
  if (activeOnly) results = results.filter((a) => a.active);
  if (capFilter) results = results.filter((a) => a.capabilities.includes(capFilter));
  res.json({ agents: results, total: results.length });
});

app.get("/api/agents/:id", (req, res) => {
  const agent = agents.get(Number(req.params.id));
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(agent);
});

app.post("/api/agents", (req, res) => {
  const { name, capabilities, pricePerTask, metadataURI } = req.body;
  if (!name || !capabilities || !capabilities.length) {
    return res.status(400).json({ error: "name and capabilities are required" });
  }
  const id = nextAgentId++;
  const agent = {
    id,
    owner: `0xDEMO${crypto.randomBytes(18).toString("hex")}`,
    name,
    metadataURI: metadataURI || "",
    capabilities,
    pricePerTask: pricePerTask || "0",
    totalJobsCompleted: 0,
    ratingSum: 0,
    ratingCount: 0,
    ratingAvg: 0,
    active: true,
    registeredAt: now(),
  };
  agents.set(id, agent);
  pushActivity("AgentRegistered", { agentId: id, name, capabilities });
  res.status(201).json({ agentId: id, txHash: `0xdemo_${uid()}` });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Agent Matching
// ─────────────────────────────────────────────────────────────

app.post("/api/agents/match", (req, res) => {
  const { capabilities, maxPricePerTask, minRating } = req.body;
  if (!capabilities || !capabilities.length) {
    return res.status(400).json({ error: "capabilities array required" });
  }

  let candidates = [...agents.values()].filter((a) => a.active);

  // Score by capability overlap
  candidates = candidates.map((a) => {
    const overlap = capabilities.filter((c) => a.capabilities.includes(c));
    return { ...a, matchScore: overlap.length / capabilities.length };
  });
  candidates = candidates.filter((c) => c.matchScore > 0);

  if (maxPricePerTask) {
    const max = BigInt(maxPricePerTask);
    candidates = candidates.filter((c) => BigInt(c.pricePerTask) <= max);
  }
  if (minRating) {
    candidates = candidates.filter((c) => c.ratingAvg >= minRating);
  }

  // Sort by match score desc, then by rating desc
  candidates.sort((a, b) => b.matchScore - a.matchScore || b.ratingAvg - a.ratingAvg);

  pushActivity("AgentMatchQuery", { capabilities, results: candidates.length });
  res.json({ matches: candidates, total: candidates.length });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Jobs (full lifecycle)
// ─────────────────────────────────────────────────────────────

app.get("/api/jobs", (_req, res) => {
  const statusFilter = _req.query.status;
  let results = [...jobs.values()];
  if (statusFilter) results = results.filter((j) => j.status === statusFilter);
  res.json({ jobs: results, total: results.length });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// CREATE
app.post("/api/jobs", (req, res) => {
  const { description, requiredCapabilities, budgetWei } = req.body;
  if (!description || !requiredCapabilities || !budgetWei) {
    return res.status(400).json({ error: "description, requiredCapabilities, budgetWei required" });
  }
  const id = nextJobId++;
  const job = {
    id,
    client: `0xDEMO${crypto.randomBytes(18).toString("hex")}`,
    budget: budgetWei,
    description,
    requiredCapabilities,
    assignedAgentId: 0,
    status: "Open",
    createdAt: now(),
    completedAt: 0,
    clientRating: 0,
    escrow: budgetWei,
  };
  jobs.set(id, job);
  pushActivity("JobPosted", { jobId: id, budget: budgetWei });
  res.status(201).json({ jobId: id, txHash: `0xdemo_${uid()}` });
});

// ASSIGN
app.post("/api/jobs/:id/assign", (req, res) => {
  const job = jobs.get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "Open") return res.status(400).json({ error: `Job is ${job.status}, not Open` });

  const { agentId } = req.body;
  if (!agentId || !agents.has(agentId)) {
    return res.status(400).json({ error: "Valid agentId required" });
  }
  job.assignedAgentId = agentId;
  job.status = "Assigned";
  pushActivity("JobAssigned", { jobId: job.id, agentId });
  res.json({ jobId: job.id, status: job.status, txHash: `0xdemo_${uid()}` });
});

// START
app.post("/api/jobs/:id/start", (req, res) => {
  const job = jobs.get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "Assigned") return res.status(400).json({ error: `Job is ${job.status}, not Assigned` });

  job.status = "InProgress";
  pushActivity("JobStarted", { jobId: job.id });
  res.json({ jobId: job.id, status: job.status, txHash: `0xdemo_${uid()}` });
});

// SUBMIT (agent submits work)
app.post("/api/jobs/:id/submit", (req, res) => {
  const job = jobs.get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "InProgress") return res.status(400).json({ error: `Job is ${job.status}, not InProgress` });

  job.status = "UnderReview";
  pushActivity("JobSubmitted", { jobId: job.id });
  res.json({ jobId: job.id, status: job.status, txHash: `0xdemo_${uid()}` });
});

// APPROVE (client approves + rates)
app.post("/api/jobs/:id/approve", (req, res) => {
  const job = jobs.get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "UnderReview") return res.status(400).json({ error: `Job is ${job.status}, not UnderReview` });

  const rating = req.body.rating || 5;
  job.status = "Completed";
  job.completedAt = now();
  job.clientRating = Math.min(5, Math.max(1, rating));
  job.escrow = "0";

  // Update agent stats
  const agent = agents.get(job.assignedAgentId);
  if (agent) {
    agent.totalJobsCompleted += 1;
    agent.ratingSum = (agent.ratingSum || 0) + job.clientRating;
    agent.ratingCount += 1;
    agent.ratingAvg = +(agent.ratingSum / agent.ratingCount).toFixed(2);

    // Credit pending withdrawal
    const prev = BigInt(withdrawals.get(agent.owner) || "0");
    const payment = BigInt(job.budget) * 95n / 100n; // 5% platform fee
    withdrawals.set(agent.owner, (prev + payment).toString());
  }

  pushActivity("JobCompleted", { jobId: job.id, rating: job.clientRating });
  res.json({ jobId: job.id, status: job.status, rating: job.clientRating, txHash: `0xdemo_${uid()}` });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Agent-to-Agent Hiring
// ─────────────────────────────────────────────────────────────

app.post("/api/agents/hire", (req, res) => {
  const { hirerAgentId, hiredAgentId, jobId } = req.body;

  if (!hirerAgentId || !hiredAgentId || !jobId) {
    return res.status(400).json({ error: "hirerAgentId, hiredAgentId, and jobId are required" });
  }

  const hirer = agents.get(hirerAgentId);
  const hired = agents.get(hiredAgentId);
  const job = jobs.get(jobId);

  if (!hirer) return res.status(404).json({ error: "Hirer agent not found" });
  if (!hired) return res.status(404).json({ error: "Hired agent not found" });
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (hirerAgentId === hiredAgentId) return res.status(400).json({ error: "Agent cannot hire itself" });

  const event = {
    id: uid(),
    hirerAgentId,
    hiredAgentId,
    jobId,
    timestamp: now(),
  };
  hireEvents.push(event);

  pushActivity("AgentHiredAgent", {
    hirerAgentId,
    hirerName: hirer.name,
    hiredAgentId,
    hiredName: hired.name,
    jobId,
  });

  res.status(201).json({
    hireEvent: event,
    message: `${hirer.name} hired ${hired.name} for job #${jobId}`,
    txHash: `0xdemo_${uid()}`,
  });
});

app.get("/api/agents/:id/hires", (req, res) => {
  const agentId = Number(req.params.id);
  const asHirer = hireEvents.filter((e) => e.hirerAgentId === agentId);
  const asHired = hireEvents.filter((e) => e.hiredAgentId === agentId);
  res.json({ asHirer, asHired });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Payment / Withdrawals
// ─────────────────────────────────────────────────────────────

app.get("/api/payments/pending/:address", (req, res) => {
  const balance = withdrawals.get(req.params.address) || "0";
  res.json({ address: req.params.address, pendingWei: balance });
});

app.post("/api/payments/withdraw", (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });

  const balance = withdrawals.get(address) || "0";
  if (balance === "0") return res.status(400).json({ error: "No pending balance" });

  withdrawals.set(address, "0");
  pushActivity("FundsWithdrawn", { address, amount: balance });
  res.json({
    address,
    withdrawnWei: balance,
    txHash: `0xdemo_${uid()}`,
  });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Activity feed
// ─────────────────────────────────────────────────────────────

app.get("/api/activity", (_req, res) => {
  const limit = Math.min(Number(_req.query.limit) || 50, MAX_FEED);
  res.json({ events: activityFeed.slice(0, limit), total: activityFeed.length });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Analytics
// ─────────────────────────────────────────────────────────────

app.get("/api/analytics", (_req, res) => {
  const totalAgents = agents.size;
  const activeAgents = [...agents.values()].filter((a) => a.active).length;
  const totalJobs = jobs.size;
  const completedJobs = [...jobs.values()].filter((j) => j.status === "Completed").length;
  const openJobs = [...jobs.values()].filter((j) => j.status === "Open").length;
  const totalVolume = [...jobs.values()]
    .filter((j) => j.status === "Completed")
    .reduce((sum, j) => sum + BigInt(j.budget), 0n);
  const totalHires = hireEvents.length;

  res.json({
    totalAgents,
    activeAgents,
    totalJobs,
    completedJobs,
    openJobs,
    inProgressJobs: totalJobs - completedJobs - openJobs,
    totalVolumeWei: totalVolume.toString(),
    totalVolumeEth: +(Number(totalVolume) / 1e18).toFixed(4),
    platformFeePercent: 5,
    totalAgentToAgentHires: totalHires,
  });
});

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────

seed();

server.listen(PORT, () => {
  console.log(`
┌──────────────────────────────────────────────────┐
│       GARRA Demo Server                          │
│       The App Store for AI Agents                │
│                                                  │
│  REST API:   http://localhost:${PORT}              │
│  WebSocket:  ws://localhost:${PORT}/ws              │
│  Mode:       Demo (no blockchain required)       │
│                                                  │
│  Agents:     ${agents.size} seeded                         │
│  Jobs:       ${jobs.size} seeded (Open, InProgress, Done)  │
│  Hires:      ${hireEvents.length} agent-to-agent events            │
└──────────────────────────────────────────────────┘
  `);
});
