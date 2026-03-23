import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

// ─────────────────────────────────────────────────────────────
//  OpenClaw SDK Integration
//  @see https://docs.openclaw.ai/sdk
// ─────────────────────────────────────────────────────────────

interface OpenClawAgentConfig {
  agentId: string;
  name: string;
  capabilities: string[];
  endpoint: string;
  apiKey: string;
}

interface OpenClawMessage {
  from: string;
  to: string;
  type: "discovery" | "negotiate" | "hire" | "complete" | "dispute";
  payload: Record<string, unknown>;
  timestamp: number;
}

/**
 * OpenClaw SDK client stub.
 * In production, replace with: import { OpenClawClient } from "@openclaw/sdk";
 *
 * This provides the integration surface for autonomous agent-to-agent
 * communication via the OpenClaw orchestration protocol.
 */
class OpenClawClient {
  private config: OpenClawAgentConfig;

  constructor(config: OpenClawAgentConfig) {
    this.config = config;
    console.log(`[OpenClaw] Agent "${config.name}" initialized (id: ${config.agentId})`);
  }

  /** Register this agent with the OpenClaw network for discovery. */
  async registerAgent(): Promise<{ registered: boolean; networkId: string }> {
    // TODO: Replace with actual OpenClaw SDK call
    // return await openclawSdk.agents.register(this.config);
    console.log(`[OpenClaw] Registering agent ${this.config.agentId} on network`);
    return { registered: true, networkId: `ocn-${this.config.agentId}` };
  }

  /** Discover agents on the OpenClaw network matching required capabilities. */
  async discoverAgents(capabilities: string[]): Promise<Array<{ agentId: string; name: string; capabilities: string[]; score: number }>> {
    // TODO: Replace with actual OpenClaw SDK call
    // return await openclawSdk.discovery.search({ capabilities });
    console.log(`[OpenClaw] Discovering agents with capabilities: ${capabilities.join(", ")}`);
    return [];
  }

  /** Send a structured message to another agent via OpenClaw protocol. */
  async sendMessage(to: string, message: Omit<OpenClawMessage, "from" | "timestamp">): Promise<{ delivered: boolean; messageId: string }> {
    // TODO: Replace with actual OpenClaw SDK call
    // return await openclawSdk.messaging.send({ ...message, from: this.config.agentId });
    console.log(`[OpenClaw] Sending ${message.type} message to agent ${to}`);
    return { delivered: true, messageId: uuidv4() };
  }

  /** Subscribe to incoming messages from the OpenClaw network. */
  onMessage(handler: (message: OpenClawMessage) => void): void {
    // TODO: Replace with actual OpenClaw SDK websocket subscription
    // openclawSdk.messaging.subscribe(this.config.agentId, handler);
    console.log(`[OpenClaw] Message handler registered for agent ${this.config.agentId}`);
  }
}

// Initialize OpenClaw client (used by agent orchestration endpoints)
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || "";
const openclawClient = new OpenClawClient({
  agentId: "garra-marketplace",
  name: "Garra Marketplace Orchestrator",
  capabilities: ["discovery", "matching", "escrow", "payment"],
  endpoint: process.env.OPENCLAW_ENDPOINT || "https://api.openclaw.ai",
  apiKey: OPENCLAW_API_KEY,
});

// ─────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 4000;
const RPC_URL = process.env.RPC_URL || "https://rpc.goatnetwork.io";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "garra-dev-secret-change-in-production";

if (!CONTRACT_ADDRESS) {
  console.error("[FATAL] CONTRACT_ADDRESS environment variable is required. Set it to the deployed AgentMarketplace address.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
//  ABI (matches AgentMarketplace.sol public surface)
// ─────────────────────────────────────────────────────────────

const MARKETPLACE_ABI = [
  // Agent registration
  "function registerAgent(string,string,string[],uint256) returns (uint256)",
  "function updateAgent(uint256,string,string,string[],uint256)",
  "function deactivateAgent(uint256)",
  "function activateAgent(uint256)",
  "function agents(uint256) view returns (uint256 id, address owner, string name, string metadataURI, uint256 pricePerTask, uint256 totalJobsCompleted, uint256 totalRatingSum, uint256 ratingCount, uint256 registeredAt, bool active)",
  "function getAgentCapabilities(uint256) view returns (string[])",
  "function getAgentRating(uint256) view returns (uint256 avg, uint256 count)",
  "function getOwnerAgents(address) view returns (uint256[])",

  // Jobs
  "function postJob(string,string[]) payable returns (uint256)",
  "function assignAgent(uint256,uint256)",
  "function startJob(uint256)",
  "function submitJob(uint256)",
  "function approveAndRate(uint256,uint8)",
  "function cancelJob(uint256)",
  "function jobs(uint256) view returns (uint256 id, address client, uint256 budget, string description, uint256 assignedAgentId, uint8 status, uint256 createdAt, uint256 completedAt, uint8 clientRating)",
  "function getJobRequiredCapabilities(uint256) view returns (string[])",
  "function jobEscrow(uint256) view returns (uint256)",

  // Workflows
  "function createWorkflow(uint256,uint256[],uint256[]) returns (uint256)",
  "function getWorkflow(uint256) view returns (uint256 id, uint256 jobId, bool finalized, uint256 stepCount)",
  "function getWorkflowStep(uint256,uint256) view returns (uint256 agentId, uint256 revenueShareBps)",

  // Agent-to-agent
  "function hireAgent(uint256,uint256,uint256)",
  "function getAgentHiredAgents(uint256) view returns (uint256[])",

  // Disputes
  "function openDispute(uint256,string) returns (uint256)",
  "function resolveDispute(uint256,uint8)",
  "function disputes(uint256) view returns (uint256 id, uint256 jobId, address initiator, string reason, uint8 outcome, uint256 createdAt, uint256 resolvedAt)",

  // Withdrawals (pull-based payment pattern)
  "function withdraw()",
  "function pendingWithdrawals(address) view returns (uint256)",
  "function cancelExpiredJob(uint256)",

  // Admin
  "function platformFeeBps() view returns (uint256)",
  "function nextAgentId() view returns (uint256)",
  "function nextJobId() view returns (uint256)",

  // Events
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, string name)",
  "event JobPosted(uint256 indexed jobId, address indexed client, uint256 budget)",
  "event JobAssigned(uint256 indexed jobId, uint256 indexed agentId)",
  "event JobStarted(uint256 indexed jobId)",
  "event JobSubmitted(uint256 indexed jobId)",
  "event JobCompleted(uint256 indexed jobId, uint8 rating)",
  "event JobCancelled(uint256 indexed jobId)",
  "event DisputeOpened(uint256 indexed disputeId, uint256 indexed jobId, address initiator)",
  "event DisputeResolved(uint256 indexed disputeId, uint8 outcome)",
  "event EscrowDeposited(uint256 indexed jobId, uint256 amount)",
  "event EscrowReleased(uint256 indexed jobId, uint256 amount)",
  "event EscrowRefunded(uint256 indexed jobId, uint256 amount)",
  "event AgentHiredAgent(uint256 indexed hirerAgentId, uint256 indexed hiredAgentId, uint256 indexed jobId)",
  "event WorkflowCreated(uint256 indexed workflowId, uint256 indexed jobId)",
  "event FundsWithdrawn(address indexed recipient, uint256 amount)",
  "event JobExpired(uint256 indexed jobId)",
];

// ─────────────────────────────────────────────────────────────
//  Ethers setup
// ─────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL);

const signer =
  PRIVATE_KEY.length > 0 ? new ethers.Wallet(PRIVATE_KEY, provider) : null;

const readContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  MARKETPLACE_ABI,
  provider
);

const writeContract =
  signer !== null
    ? new ethers.Contract(CONTRACT_ADDRESS, MARKETPLACE_ABI, signer)
    : null;

// ─────────────────────────────────────────────────────────────
//  In-memory stores (mirrors on-chain for fast reads + extras)
// ─────────────────────────────────────────────────────────────

interface AgentRecord {
  id: number;
  owner: string;
  name: string;
  metadataURI: string;
  capabilities: string[];
  pricePerTask: string;
  totalJobsCompleted: number;
  ratingAvg: number;
  ratingCount: number;
  active: boolean;
  registeredAt: number;
}

interface JobRecord {
  id: number;
  client: string;
  budget: string;
  description: string;
  requiredCapabilities: string[];
  assignedAgentId: number;
  status: string;
  createdAt: number;
  completedAt: number;
  clientRating: number;
  escrow: string;
}

interface ActivityEvent {
  id: string;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

const agentCache = new Map<number, AgentRecord>();
const jobCache = new Map<number, JobRecord>();
const activityFeed: ActivityEvent[] = [];
const MAX_FEED_SIZE = 500;

function pushActivity(type: string, data: Record<string, unknown>): void {
  const event: ActivityEvent = {
    id: uuidv4(),
    type,
    timestamp: Date.now(),
    data,
  };
  activityFeed.unshift(event);
  if (activityFeed.length > MAX_FEED_SIZE) activityFeed.pop();
  broadcastWs({ kind: "activity", payload: event });
}

// ─────────────────────────────────────────────────────────────
//  Zod Schemas
// ─────────────────────────────────────────────────────────────

const RegisterAgentSchema = z.object({
  name: z.string().min(1).max(128),
  metadataURI: z.string().max(512).default(""),
  capabilities: z.array(z.string().min(1)).min(1),
  pricePerTask: z.string().regex(/^\d+$/, "Must be a wei amount"),
});

const PostJobSchema = z.object({
  description: z.string().min(1).max(2048),
  requiredCapabilities: z.array(z.string().min(1)).min(1),
  budgetWei: z.string().regex(/^\d+$/, "Must be a wei amount"),
});

const AssignAgentSchema = z.object({
  agentId: z.number().int().positive(),
});

const RateJobSchema = z.object({
  rating: z.number().int().min(1).max(5),
});

const CreateWorkflowSchema = z.object({
  agentIds: z.array(z.number().int().positive()).min(1),
  revenueSharesBps: z.array(z.number().int().min(0).max(10000)).min(1),
});

const HireAgentSchema = z.object({
  hirerAgentId: z.number().int().positive(),
  hiredAgentId: z.number().int().positive(),
});

const OpenDisputeSchema = z.object({
  reason: z.string().min(1).max(2048),
});

const ResolveDisputeSchema = z.object({
  outcome: z.enum(["FavorClient", "FavorAgent", "Split"]),
});

const MatchAgentsSchema = z.object({
  capabilities: z.array(z.string().min(1)).min(1),
  maxPricePerTask: z.string().regex(/^\d+$/).optional(),
  minRating: z.number().int().min(0).max(5).optional(),
});

// ─────────────────────────────────────────────────────────────
//  Express + WebSocket
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("short"));

// ─────────────────────────────────────────────────────────────
//  JWT Authentication Middleware
// ─────────────────────────────────────────────────────────────

interface AuthPayload {
  sub: string;       // wallet address or user ID
  role: "user" | "admin" | "agent";
  iat: number;
  exp: number;
}

/**
 * Middleware that verifies JWT tokens on protected routes.
 * Public routes (GET /health, GET /api/agents, GET /api/jobs, etc.) are exempt.
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Allow public read-only endpoints without auth
  const publicPaths = ["/health", "/api/activity"];
  const isPublicGet =
    req.method === "GET" &&
    (publicPaths.includes(req.path) ||
     req.path.startsWith("/api/agents") ||
     req.path.startsWith("/api/jobs") ||
     req.path.startsWith("/api/workflows") ||
     req.path.startsWith("/api/disputes") ||
     req.path.startsWith("/api/analytics"));

  if (isPublicGet) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header. Use: Bearer <token>" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthPayload;
    (req as Request & { auth: AuthPayload }).auth = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
}

app.use(authMiddleware);

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });
const wsClients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
  ws.send(JSON.stringify({ kind: "connected", timestamp: Date.now() }));
});

function broadcastWs(msg: Record<string, unknown>): void {
  const payload = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

const JOB_STATUS_LABELS: Record<number, string> = {
  0: "Open",
  1: "Assigned",
  2: "InProgress",
  3: "UnderReview",
  4: "Completed",
  5: "Disputed",
  6: "Cancelled",
  7: "Resolved",
};

const DISPUTE_OUTCOME_MAP: Record<string, number> = {
  FavorClient: 1,
  FavorAgent: 2,
  Split: 3,
};

function requireWriteContract(): ethers.Contract {
  if (!writeContract) {
    throw new Error("Write operations unavailable: no PRIVATE_KEY configured");
  }
  return writeContract;
}

async function syncAgent(id: number): Promise<AgentRecord | null> {
  try {
    const raw = await readContract.agents(id);
    const caps: string[] = await readContract.getAgentCapabilities(id);
    const record: AgentRecord = {
      id: Number(raw.id),
      owner: raw.owner,
      name: raw.name,
      metadataURI: raw.metadataURI,
      capabilities: caps,
      pricePerTask: raw.pricePerTask.toString(),
      totalJobsCompleted: Number(raw.totalJobsCompleted),
      ratingAvg: Number(raw.ratingCount) > 0
        ? Number(raw.totalRatingSum) / Number(raw.ratingCount)
        : 0,
      ratingCount: Number(raw.ratingCount),
      active: raw.active,
      registeredAt: Number(raw.registeredAt),
    };
    agentCache.set(id, record);
    return record;
  } catch {
    return null;
  }
}

async function syncJob(id: number): Promise<JobRecord | null> {
  try {
    const raw = await readContract.jobs(id);
    const caps: string[] = await readContract.getJobRequiredCapabilities(id);
    const escrow: bigint = await readContract.jobEscrow(id);
    const record: JobRecord = {
      id: Number(raw.id),
      client: raw.client,
      budget: raw.budget.toString(),
      description: raw.description,
      requiredCapabilities: caps,
      assignedAgentId: Number(raw.assignedAgentId),
      status: JOB_STATUS_LABELS[Number(raw.status)] ?? "Unknown",
      createdAt: Number(raw.createdAt),
      completedAt: Number(raw.completedAt),
      clientRating: Number(raw.clientRating),
      escrow: escrow.toString(),
    };
    jobCache.set(id, record);
    return record;
  } catch {
    return null;
  }
}

function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => fn(req, res).catch(next);
}

// ─────────────────────────────────────────────────────────────
//  Routes: Health
// ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    contract: CONTRACT_ADDRESS,
    rpc: RPC_URL,
    timestamp: Date.now(),
  });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Agent Registry
// ─────────────────────────────────────────────────────────────

app.post(
  "/api/agents",
  asyncHandler(async (req, res) => {
    const body = RegisterAgentSchema.parse(req.body);
    const contract = requireWriteContract();

    const tx = await contract.registerAgent(
      body.name,
      body.metadataURI,
      body.capabilities,
      BigInt(body.pricePerTask)
    );
    const receipt = await tx.wait();

    const iface = new ethers.Interface(MARKETPLACE_ABI);
    let agentId: number | null = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "AgentRegistered") {
          agentId = Number(parsed.args[0]);
        }
      } catch {
        // skip unrelated logs
      }
    }

    pushActivity("AgentRegistered", {
      agentId,
      name: body.name,
      capabilities: body.capabilities,
    });

    res.status(201).json({
      agentId,
      txHash: receipt.hash,
    });
  })
);

app.get(
  "/api/agents/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const agent = await syncAgent(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(agent);
  })
);

app.get(
  "/api/agents",
  asyncHandler(async (req, res) => {
    const nextId = Number(await readContract.nextAgentId());
    const results: AgentRecord[] = [];

    const capFilter = req.query.capability as string | undefined;
    const activeOnly = req.query.active !== "false";

    for (let i = 1; i < nextId; i++) {
      const agent = await syncAgent(i);
      if (!agent) continue;
      if (activeOnly && !agent.active) continue;
      if (capFilter && !agent.capabilities.includes(capFilter)) continue;
      results.push(agent);
    }

    res.json({ agents: results, total: results.length });
  })
);

app.put(
  "/api/agents/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = RegisterAgentSchema.parse(req.body);
    const contract = requireWriteContract();

    const tx = await contract.updateAgent(
      id,
      body.name,
      body.metadataURI,
      body.capabilities,
      BigInt(body.pricePerTask)
    );
    const receipt = await tx.wait();

    await syncAgent(id);
    pushActivity("AgentUpdated", { agentId: id });

    res.json({ txHash: receipt.hash });
  })
);

app.delete(
  "/api/agents/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const contract = requireWriteContract();

    const tx = await contract.deactivateAgent(id);
    const receipt = await tx.wait();

    await syncAgent(id);
    pushActivity("AgentDeactivated", { agentId: id });

    res.json({ txHash: receipt.hash });
  })
);

// ─────────────────────────────────────────────────────────────
//  Routes: Agent Matching / Orchestration
// ─────────────────────────────────────────────────────────────

app.post(
  "/api/agents/match",
  asyncHandler(async (req, res) => {
    const body = MatchAgentsSchema.parse(req.body);
    const nextId = Number(await readContract.nextAgentId());
    const matches: Array<AgentRecord & { matchScore: number }> = [];

    for (let i = 1; i < nextId; i++) {
      const agent = await syncAgent(i);
      if (!agent || !agent.active) continue;

      // Capability overlap
      const overlap = body.capabilities.filter((c) =>
        agent.capabilities.includes(c)
      );
      if (overlap.length === 0) continue;

      // Price filter
      if (
        body.maxPricePerTask &&
        BigInt(agent.pricePerTask) > BigInt(body.maxPricePerTask)
      ) {
        continue;
      }

      // Rating filter
      if (body.minRating && agent.ratingAvg < body.minRating) continue;

      const matchScore =
        (overlap.length / body.capabilities.length) * 0.6 +
        (agent.ratingAvg / 5) * 0.3 +
        Math.min(agent.totalJobsCompleted / 100, 1) * 0.1;

      matches.push({ ...agent, matchScore });
    }

    matches.sort((a, b) => b.matchScore - a.matchScore);

    res.json({ matches, total: matches.length });
  })
);

// ─────────────────────────────────────────────────────────────
//  Routes: Job Marketplace
// ─────────────────────────────────────────────────────────────

app.post(
  "/api/jobs",
  asyncHandler(async (req, res) => {
    const body = PostJobSchema.parse(req.body);
    const contract = requireWriteContract();

    const tx = await contract.postJob(
      body.description,
      body.requiredCapabilities,
      { value: BigInt(body.budgetWei) }
    );
    const receipt = await tx.wait();

    const iface = new ethers.Interface(MARKETPLACE_ABI);
    let jobId: number | null = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "JobPosted") {
          jobId = Number(parsed.args[0]);
        }
      } catch {
        // skip
      }
    }

    pushActivity("JobPosted", {
      jobId,
      budget: body.budgetWei,
      capabilities: body.requiredCapabilities,
    });

    res.status(201).json({ jobId, txHash: receipt.hash });
  })
);

app.get(
  "/api/jobs",
  asyncHandler(async (req, res) => {
    const nextId = Number(await readContract.nextJobId());
    const results: JobRecord[] = [];
    const statusFilter = req.query.status as string | undefined;

    for (let i = 1; i < nextId; i++) {
      const job = await syncJob(i);
      if (!job) continue;
      if (statusFilter && job.status !== statusFilter) continue;
      results.push(job);
    }

    res.json({ jobs: results, total: results.length });
  })
);

app.get(
  "/api/jobs/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const job = await syncJob(id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  })
);

app.post(
  "/api/jobs/:id/assign",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id);
    const body = AssignAgentSchema.parse(req.body);
    const contract = requireWriteContract();

    const tx = await contract.assignAgent(jobId, body.agentId);
    const receipt = await tx.wait();

    await syncJob(jobId);
    pushActivity("JobAssigned", { jobId, agentId: body.agentId });

    res.json({ txHash: receipt.hash });
  })
);

app.post(
  "/api/jobs/:id/start",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id);
    const contract = requireWriteContract();

    const tx = await contract.startJob(jobId);
    const receipt = await tx.wait();

    await syncJob(jobId);
    pushActivity("JobStarted", { jobId });

    res.json({ txHash: receipt.hash });
  })
);

app.post(
  "/api/jobs/:id/submit",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id);
    const contract = requireWriteContract();

    const tx = await contract.submitJob(jobId);
    const receipt = await tx.wait();

    await syncJob(jobId);
    pushActivity("JobSubmitted", { jobId });

    res.json({ txHash: receipt.hash });
  })
);

app.post(
  "/api/jobs/:id/approve",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id);
    const body = RateJobSchema.parse(req.body);
    const contract = requireWriteContract();

    const tx = await contract.approveAndRate(jobId, body.rating);
    const receipt = await tx.wait();

    await syncJob(jobId);
    pushActivity("JobCompleted", { jobId, rating: body.rating });

    res.json({ txHash: receipt.hash });
  })
);

app.post(
  "/api/jobs/:id/cancel",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id);
    const contract = requireWriteContract();

    const tx = await contract.cancelJob(jobId);
    const receipt = await tx.wait();

    await syncJob(jobId);
    pushActivity("JobCancelled", { jobId });

    res.json({ txHash: receipt.hash });
  })
);

// ─────────────────────────────────────────────────────────────
//  Routes: Agent-to-Agent Hiring
// ─────────────────────────────────────────────────────────────

app.post(
  "/api/jobs/:id/hire-agent",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id);
    const body = HireAgentSchema.parse(req.body);
    const contract = requireWriteContract();

    const tx = await contract.hireAgent(
      body.hirerAgentId,
      body.hiredAgentId,
      jobId
    );
    const receipt = await tx.wait();

    pushActivity("AgentHiredAgent", {
      jobId,
      hirerAgentId: body.hirerAgentId,
      hiredAgentId: body.hiredAgentId,
    });

    res.json({ txHash: receipt.hash });
  })
);

// ─────────────────────────────────────────────────────────────
//  Routes: Workflows (Revenue Sharing)
// ─────────────────────────────────────────────────────────────

app.post(
  "/api/jobs/:id/workflow",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id);
    const body = CreateWorkflowSchema.parse(req.body);
    const contract = requireWriteContract();

    const tx = await contract.createWorkflow(
      jobId,
      body.agentIds,
      body.revenueSharesBps
    );
    const receipt = await tx.wait();

    const iface = new ethers.Interface(MARKETPLACE_ABI);
    let workflowId: number | null = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "WorkflowCreated") {
          workflowId = Number(parsed.args[0]);
        }
      } catch {
        // skip
      }
    }

    pushActivity("WorkflowCreated", {
      workflowId,
      jobId,
      agentIds: body.agentIds,
      shares: body.revenueSharesBps,
    });

    res.status(201).json({ workflowId, txHash: receipt.hash });
  })
);

app.get(
  "/api/workflows/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const wf = await readContract.getWorkflow(id);
    const stepCount = Number(wf.stepCount);
    const steps = [];

    for (let i = 0; i < stepCount; i++) {
      const step = await readContract.getWorkflowStep(id, i);
      steps.push({
        agentId: Number(step.agentId),
        revenueShareBps: Number(step.revenueShareBps),
      });
    }

    res.json({
      id: Number(wf.id),
      jobId: Number(wf.jobId),
      finalized: wf.finalized,
      steps,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  Routes: Disputes
// ─────────────────────────────────────────────────────────────

app.post(
  "/api/jobs/:id/dispute",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id);
    const body = OpenDisputeSchema.parse(req.body);
    const contract = requireWriteContract();

    const tx = await contract.openDispute(jobId, body.reason);
    const receipt = await tx.wait();

    const iface = new ethers.Interface(MARKETPLACE_ABI);
    let disputeId: number | null = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "DisputeOpened") {
          disputeId = Number(parsed.args[0]);
        }
      } catch {
        // skip
      }
    }

    pushActivity("DisputeOpened", { disputeId, jobId, reason: body.reason });

    res.status(201).json({ disputeId, txHash: receipt.hash });
  })
);

app.post(
  "/api/disputes/:id/resolve",
  asyncHandler(async (req, res) => {
    const disputeId = Number(req.params.id);
    const body = ResolveDisputeSchema.parse(req.body);
    const contract = requireWriteContract();

    const outcomeInt = DISPUTE_OUTCOME_MAP[body.outcome];
    const tx = await contract.resolveDispute(disputeId, outcomeInt);
    const receipt = await tx.wait();

    pushActivity("DisputeResolved", {
      disputeId,
      outcome: body.outcome,
    });

    res.json({ txHash: receipt.hash });
  })
);

app.get(
  "/api/disputes/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const d = await readContract.disputes(id);

    res.json({
      id: Number(d.id),
      jobId: Number(d.jobId),
      initiator: d.initiator,
      reason: d.reason,
      outcome: ["Pending", "FavorClient", "FavorAgent", "Split"][
        Number(d.outcome)
      ],
      createdAt: Number(d.createdAt),
      resolvedAt: Number(d.resolvedAt),
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  Routes: Activity Feed
// ─────────────────────────────────────────────────────────────

app.get("/api/activity", (_req, res) => {
  const limit = Math.min(Number(_req.query.limit) || 50, MAX_FEED_SIZE);
  const offset = Number(_req.query.offset) || 0;
  res.json({
    events: activityFeed.slice(offset, offset + limit),
    total: activityFeed.length,
  });
});

// ─────────────────────────────────────────────────────────────
//  Routes: Analytics & Reporting
// ─────────────────────────────────────────────────────────────

app.get(
  "/api/analytics",
  asyncHandler(async (_req, res) => {
    const totalAgents = Number(await readContract.nextAgentId()) - 1;
    const totalJobs = Number(await readContract.nextJobId()) - 1;
    const platformFeeBps = Number(await readContract.platformFeeBps());

    // Aggregate from cache
    let activeAgents = 0;
    let totalJobsCompleted = 0;
    let totalRatings = 0;
    let ratingSum = 0;
    let totalBudget = 0n;

    for (const [, agent] of agentCache) {
      if (agent.active) activeAgents++;
      totalJobsCompleted += agent.totalJobsCompleted;
      ratingSum += agent.ratingAvg * agent.ratingCount;
      totalRatings += agent.ratingCount;
    }

    for (const [, job] of jobCache) {
      totalBudget += BigInt(job.budget);
    }

    const statusBreakdown: Record<string, number> = {};
    for (const [, job] of jobCache) {
      statusBreakdown[job.status] = (statusBreakdown[job.status] || 0) + 1;
    }

    res.json({
      totalAgents,
      activeAgents,
      totalJobs,
      totalJobsCompleted,
      averageRating:
        totalRatings > 0 ? (ratingSum / totalRatings).toFixed(2) : "0.00",
      totalBudgetWei: totalBudget.toString(),
      platformFeeBps,
      jobStatusBreakdown: statusBreakdown,
      activityFeedSize: activityFeed.length,
      wsConnections: wsClients.size,
    });
  })
);

app.get(
  "/api/analytics/agents/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const agent = await syncAgent(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const hiredAgents: number[] = await readContract.getAgentHiredAgents(id);

    // Count jobs assigned to this agent
    let jobsAssigned = 0;
    let totalEarningsEstimate = 0n;

    for (const [, job] of jobCache) {
      if (job.assignedAgentId === id) {
        jobsAssigned++;
        if (job.status === "Completed") {
          totalEarningsEstimate += BigInt(job.budget);
        }
      }
    }

    res.json({
      agent,
      jobsAssigned,
      totalEarningsEstimateWei: totalEarningsEstimate.toString(),
      hiredAgentIds: hiredAgents.map(Number),
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  Error handler
// ─────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err.name === "ZodError") {
    res.status(400).json({ error: "Validation error", details: err });
    return;
  }
  console.error("[ERROR]", err.message);
  // Do not expose internal error details to clients
  res.status(500).json({ error: "Internal server error" });
});

// ─────────────────────────────────────────────────────────────
//  Chain event listener (real-time sync)
// ─────────────────────────────────────────────────────────────

async function startEventListeners(): Promise<void> {

  try {
    readContract.on("AgentRegistered", (agentId: bigint, owner: string, name: string) => {
      const id = Number(agentId);
      syncAgent(id).catch(console.error);
      pushActivity("AgentRegistered", { agentId: id, owner, name });
    });

    readContract.on("JobPosted", (jobId: bigint, client: string, budget: bigint) => {
      const id = Number(jobId);
      syncJob(id).catch(console.error);
      pushActivity("JobPosted", {
        jobId: id,
        client,
        budget: budget.toString(),
      });
    });

    readContract.on("JobCompleted", (jobId: bigint, rating: number) => {
      const id = Number(jobId);
      syncJob(id).catch(console.error);
      pushActivity("JobCompleted", { jobId: id, rating });
    });

    readContract.on("DisputeOpened", (disputeId: bigint, jobId: bigint, initiator: string) => {
      pushActivity("DisputeOpened", {
        disputeId: Number(disputeId),
        jobId: Number(jobId),
        initiator,
      });
    });

    readContract.on("DisputeResolved", (disputeId: bigint, outcome: number) => {
      const labels = ["Pending", "FavorClient", "FavorAgent", "Split"];
      pushActivity("DisputeResolved", {
        disputeId: Number(disputeId),
        outcome: labels[outcome] ?? "Unknown",
      });
    });

    readContract.on(
      "AgentHiredAgent",
      (hirerAgentId: bigint, hiredAgentId: bigint, jobId: bigint) => {
        pushActivity("AgentHiredAgent", {
          hirerAgentId: Number(hirerAgentId),
          hiredAgentId: Number(hiredAgentId),
          jobId: Number(jobId),
        });
      }
    );

    console.log("[INFO] On-chain event listeners started");
  } catch (err) {
    console.error("[WARN] Failed to start event listeners:", err);
  }
}

// ─────────────────────────────────────────────────────────────
//  Bootstrap
// ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Garra] Server running on http://localhost:${PORT}`);
  console.log(`[Garra] WebSocket at ws://localhost:${PORT}/ws`);
  console.log(`[Garra] Contract: ${CONTRACT_ADDRESS}`);
  console.log(`[Garra] RPC: ${RPC_URL}`);
  startEventListeners().catch(console.error);

  // Register with OpenClaw network on startup
  openclawClient.registerAgent().then((result) => {
    console.log(`[Garra] OpenClaw registration: ${result.registered ? "OK" : "FAILED"} (networkId: ${result.networkId})`);
  }).catch((err) => {
    console.warn(`[Garra] OpenClaw registration failed:`, err);
  });
});

// ─────────────────────────────────────────────────────────────
//  Graceful Shutdown
// ─────────────────────────────────────────────────────────────

function gracefulShutdown(signal: string): void {
  console.log(`[Garra] ${signal} received. Shutting down gracefully...`);
  server.close(() => {
    wss.close(() => {
      console.log("[Garra] Server closed.");
      process.exit(0);
    });
  });
  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error("[Garra] Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export { app, server };
