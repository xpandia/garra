// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title AgentMarketplace
 * @notice Autonomous AI Agent Marketplace with on-chain payments on GOAT Network.
 *         Supports agent registration, job posting/matching, escrow, agent-to-agent
 *         hiring, reputation, revenue sharing for composed workflows, and disputes.
 */
contract AgentMarketplace is Ownable, ReentrancyGuard, Pausable {
    // ──────────────────────────────────────────────
    //  Enums
    // ──────────────────────────────────────────────

    enum JobStatus {
        Open,
        Assigned,
        InProgress,
        UnderReview,
        Completed,
        Disputed,
        Cancelled,
        Resolved
    }

    enum DisputeOutcome {
        Pending,
        FavorClient,
        FavorAgent,
        Split
    }

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────

    struct Agent {
        uint256 id;
        address owner;
        string name;
        string metadataURI;          // IPFS / Arweave link for rich metadata
        string[] capabilities;
        uint256 pricePerTask;        // wei per task unit
        uint256 totalJobsCompleted;
        uint256 totalRatingSum;
        uint256 ratingCount;
        uint256 registeredAt;
        bool active;
    }

    struct Job {
        uint256 id;
        address client;
        uint256 budget;
        string description;
        string[] requiredCapabilities;
        uint256 assignedAgentId;
        JobStatus status;
        uint256 createdAt;
        uint256 completedAt;
        uint8 clientRating;          // 1-5 after completion
    }

    struct WorkflowStep {
        uint256 agentId;
        uint256 revenueShareBps;     // basis points (100 = 1%)
    }

    struct Workflow {
        uint256 id;
        uint256 jobId;
        WorkflowStep[] steps;
        bool finalized;
    }

    struct Dispute {
        uint256 id;
        uint256 jobId;
        address initiator;
        string reason;
        DisputeOutcome outcome;
        uint256 createdAt;
        uint256 resolvedAt;
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    uint256 public nextAgentId = 1;
    uint256 public nextJobId = 1;
    uint256 public nextWorkflowId = 1;
    uint256 public nextDisputeId = 1;

    uint256 public platformFeeBps = 500; // 5 %
    address public feeRecipient;

    mapping(uint256 => Agent) public agents;
    mapping(address => uint256[]) public ownerAgents;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => uint256) public jobEscrow;         // jobId => escrowed wei
    mapping(uint256 => Workflow) private workflows;       // workflowId => Workflow
    mapping(uint256 => uint256) public jobWorkflow;       // jobId => workflowId (0 = none)
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => uint256) public jobDispute;        // jobId => disputeId

    // Agent-to-agent hiring ledger
    mapping(uint256 => uint256[]) public agentHiredAgents; // hiringAgentId => [hiredAgentIds]

    // Pull-based withdrawal pattern (prevents griefing in multi-agent payments)
    mapping(address => uint256) public pendingWithdrawals;

    // Job timeout: jobs must be completed within this duration or can be cancelled
    uint256 public constant JOB_TIMEOUT = 30 days;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string name);
    event AgentUpdated(uint256 indexed agentId);
    event AgentDeactivated(uint256 indexed agentId);

    event JobPosted(uint256 indexed jobId, address indexed client, uint256 budget);
    event JobAssigned(uint256 indexed jobId, uint256 indexed agentId);
    event JobStarted(uint256 indexed jobId);
    event JobSubmitted(uint256 indexed jobId);
    event JobCompleted(uint256 indexed jobId, uint8 rating);
    event JobCancelled(uint256 indexed jobId);

    event WorkflowCreated(uint256 indexed workflowId, uint256 indexed jobId);
    event WorkflowFinalized(uint256 indexed workflowId);

    event AgentHiredAgent(uint256 indexed hirerAgentId, uint256 indexed hiredAgentId, uint256 indexed jobId);

    event DisputeOpened(uint256 indexed disputeId, uint256 indexed jobId, address initiator);
    event DisputeResolved(uint256 indexed disputeId, DisputeOutcome outcome);

    event EscrowDeposited(uint256 indexed jobId, uint256 amount);
    event EscrowReleased(uint256 indexed jobId, uint256 amount);
    event EscrowRefunded(uint256 indexed jobId, uint256 amount);

    event PlatformFeeUpdated(uint256 newFeeBps);
    event FundsWithdrawn(address indexed recipient, uint256 amount);
    event JobExpired(uint256 indexed jobId);

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────

    modifier onlyAgentOwner(uint256 agentId) {
        require(agents[agentId].owner == msg.sender, "Not agent owner");
        _;
    }

    modifier onlyJobClient(uint256 jobId) {
        require(jobs[jobId].client == msg.sender, "Not job client");
        _;
    }

    modifier jobInStatus(uint256 jobId, JobStatus expected) {
        require(jobs[jobId].status == expected, "Invalid job status");
        _;
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    constructor(address _feeRecipient) Ownable(msg.sender) {
        require(_feeRecipient != address(0), "Zero address");
        feeRecipient = _feeRecipient;
    }

    // ──────────────────────────────────────────────
    //  Agent Registration
    // ──────────────────────────────────────────────

    function registerAgent(
        string calldata _name,
        string calldata _metadataURI,
        string[] calldata _capabilities,
        uint256 _pricePerTask
    ) external whenNotPaused returns (uint256 agentId) {
        require(bytes(_name).length > 0, "Empty name");
        require(_capabilities.length > 0, "No capabilities");

        agentId = nextAgentId++;

        Agent storage a = agents[agentId];
        a.id = agentId;
        a.owner = msg.sender;
        a.name = _name;
        a.metadataURI = _metadataURI;
        a.pricePerTask = _pricePerTask;
        a.registeredAt = block.timestamp;
        a.active = true;

        for (uint256 i = 0; i < _capabilities.length; i++) {
            a.capabilities.push(_capabilities[i]);
        }

        ownerAgents[msg.sender].push(agentId);

        emit AgentRegistered(agentId, msg.sender, _name);
    }

    function updateAgent(
        uint256 agentId,
        string calldata _name,
        string calldata _metadataURI,
        string[] calldata _capabilities,
        uint256 _pricePerTask
    ) external onlyAgentOwner(agentId) {
        Agent storage a = agents[agentId];
        a.name = _name;
        a.metadataURI = _metadataURI;
        a.pricePerTask = _pricePerTask;

        delete a.capabilities;
        for (uint256 i = 0; i < _capabilities.length; i++) {
            a.capabilities.push(_capabilities[i]);
        }

        emit AgentUpdated(agentId);
    }

    function deactivateAgent(uint256 agentId) external onlyAgentOwner(agentId) {
        agents[agentId].active = false;
        emit AgentDeactivated(agentId);
    }

    function activateAgent(uint256 agentId) external onlyAgentOwner(agentId) {
        agents[agentId].active = true;
        emit AgentUpdated(agentId);
    }

    // ──────────────────────────────────────────────
    //  Job Posting & Matching
    // ──────────────────────────────────────────────

    function postJob(
        string calldata _description,
        string[] calldata _requiredCapabilities
    ) external payable whenNotPaused returns (uint256 jobId) {
        require(msg.value > 0, "No budget");
        require(_requiredCapabilities.length > 0, "No capabilities required");

        jobId = nextJobId++;

        Job storage j = jobs[jobId];
        j.id = jobId;
        j.client = msg.sender;
        j.budget = msg.value;
        j.description = _description;
        j.status = JobStatus.Open;
        j.createdAt = block.timestamp;

        for (uint256 i = 0; i < _requiredCapabilities.length; i++) {
            j.requiredCapabilities.push(_requiredCapabilities[i]);
        }

        jobEscrow[jobId] = msg.value;

        emit JobPosted(jobId, msg.sender, msg.value);
        emit EscrowDeposited(jobId, msg.value);
    }

    function assignAgent(
        uint256 jobId,
        uint256 agentId
    ) external onlyJobClient(jobId) jobInStatus(jobId, JobStatus.Open) {
        require(agents[agentId].active, "Agent not active");

        jobs[jobId].assignedAgentId = agentId;
        jobs[jobId].status = JobStatus.Assigned;

        emit JobAssigned(jobId, agentId);
    }

    function startJob(
        uint256 jobId
    ) external jobInStatus(jobId, JobStatus.Assigned) {
        uint256 agentId = jobs[jobId].assignedAgentId;
        require(agents[agentId].owner == msg.sender, "Not assigned agent owner");

        jobs[jobId].status = JobStatus.InProgress;
        emit JobStarted(jobId);
    }

    function submitJob(
        uint256 jobId
    ) external jobInStatus(jobId, JobStatus.InProgress) {
        uint256 agentId = jobs[jobId].assignedAgentId;
        require(agents[agentId].owner == msg.sender, "Not assigned agent owner");

        jobs[jobId].status = JobStatus.UnderReview;
        emit JobSubmitted(jobId);
    }

    function approveAndRate(
        uint256 jobId,
        uint8 rating
    ) external onlyJobClient(jobId) jobInStatus(jobId, JobStatus.UnderReview) nonReentrant {
        require(rating >= 1 && rating <= 5, "Rating 1-5");

        Job storage j = jobs[jobId];
        j.status = JobStatus.Completed;
        j.completedAt = block.timestamp;
        j.clientRating = rating;

        // Update agent reputation
        Agent storage a = agents[j.assignedAgentId];
        a.totalJobsCompleted++;
        a.totalRatingSum += rating;
        a.ratingCount++;

        // Release escrow
        _releaseEscrow(jobId);

        emit JobCompleted(jobId, rating);
    }

    function cancelJob(
        uint256 jobId
    ) external onlyJobClient(jobId) nonReentrant {
        JobStatus s = jobs[jobId].status;
        require(s == JobStatus.Open || s == JobStatus.Assigned, "Cannot cancel");

        jobs[jobId].status = JobStatus.Cancelled;

        uint256 escrowed = jobEscrow[jobId];
        jobEscrow[jobId] = 0;

        if (escrowed > 0) {
            pendingWithdrawals[jobs[jobId].client] += escrowed;
            emit EscrowRefunded(jobId, escrowed);
        }

        emit JobCancelled(jobId);
    }

    /**
     * @notice Cancel a job that has exceeded the timeout period.
     *         Anyone can call this to unlock escrowed funds for expired jobs.
     */
    function cancelExpiredJob(
        uint256 jobId
    ) external nonReentrant {
        Job storage j = jobs[jobId];
        require(
            j.status == JobStatus.Assigned || j.status == JobStatus.InProgress,
            "Job not cancellable"
        );
        require(
            block.timestamp > j.createdAt + JOB_TIMEOUT,
            "Job not expired"
        );

        j.status = JobStatus.Cancelled;

        uint256 escrowed = jobEscrow[jobId];
        jobEscrow[jobId] = 0;

        if (escrowed > 0) {
            pendingWithdrawals[j.client] += escrowed;
            emit EscrowRefunded(jobId, escrowed);
        }

        emit JobExpired(jobId);
        emit JobCancelled(jobId);
    }

    /**
     * @notice Withdraw accumulated funds (pull pattern to prevent griefing).
     */
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        pendingWithdrawals[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw failed");

        emit FundsWithdrawn(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  Agent-to-Agent Hiring
    // ──────────────────────────────────────────────

    /**
     * @notice An agent (hirer) can hire another agent to help with a job.
     *         The hirer's owner calls this. A workflow must be set up to
     *         distribute revenue among participating agents.
     */
    function hireAgent(
        uint256 hirerAgentId,
        uint256 hiredAgentId,
        uint256 jobId
    ) external onlyAgentOwner(hirerAgentId) {
        require(agents[hiredAgentId].active, "Hired agent not active");
        require(jobs[jobId].assignedAgentId == hirerAgentId, "Hirer not assigned");
        require(
            jobs[jobId].status == JobStatus.InProgress,
            "Job not in progress"
        );

        agentHiredAgents[hirerAgentId].push(hiredAgentId);

        emit AgentHiredAgent(hirerAgentId, hiredAgentId, jobId);
    }

    // ──────────────────────────────────────────────
    //  Composed Workflows & Revenue Sharing
    // ──────────────────────────────────────────────

    /**
     * @notice Create a multi-agent workflow for a job. The total revenue
     *         share basis points across all steps must equal 10000 (100 %).
     */
    function createWorkflow(
        uint256 jobId,
        uint256[] calldata agentIds,
        uint256[] calldata revenueSharesBps
    ) external onlyJobClient(jobId) returns (uint256 workflowId) {
        require(
            jobs[jobId].status == JobStatus.Open ||
            jobs[jobId].status == JobStatus.Assigned ||
            jobs[jobId].status == JobStatus.InProgress,
            "Job not in valid status for workflow"
        );
        require(agentIds.length == revenueSharesBps.length, "Length mismatch");
        require(agentIds.length > 0, "Empty workflow");
        require(jobWorkflow[jobId] == 0, "Workflow already set");

        uint256 totalBps;
        for (uint256 i = 0; i < revenueSharesBps.length; i++) {
            totalBps += revenueSharesBps[i];
        }
        require(totalBps == 10_000, "Shares must total 10000 bps");

        workflowId = nextWorkflowId++;

        Workflow storage w = workflows[workflowId];
        w.id = workflowId;
        w.jobId = jobId;

        for (uint256 i = 0; i < agentIds.length; i++) {
            require(agents[agentIds[i]].active, "Agent not active");
            w.steps.push(
                WorkflowStep({
                    agentId: agentIds[i],
                    revenueShareBps: revenueSharesBps[i]
                })
            );
        }

        jobWorkflow[jobId] = workflowId;

        emit WorkflowCreated(workflowId, jobId);
    }

    // ──────────────────────────────────────────────
    //  Dispute Resolution
    // ──────────────────────────────────────────────

    function openDispute(
        uint256 jobId,
        string calldata reason
    ) external returns (uint256 disputeId) {
        Job storage j = jobs[jobId];
        require(
            j.status == JobStatus.UnderReview || j.status == JobStatus.InProgress,
            "Cannot dispute"
        );
        require(
            msg.sender == j.client || msg.sender == agents[j.assignedAgentId].owner,
            "Not a party"
        );
        require(jobDispute[jobId] == 0, "Dispute exists");

        disputeId = nextDisputeId++;

        disputes[disputeId] = Dispute({
            id: disputeId,
            jobId: jobId,
            initiator: msg.sender,
            reason: reason,
            outcome: DisputeOutcome.Pending,
            createdAt: block.timestamp,
            resolvedAt: 0
        });

        jobDispute[jobId] = disputeId;
        j.status = JobStatus.Disputed;

        emit DisputeOpened(disputeId, jobId, msg.sender);
    }

    /**
     * @notice Platform owner resolves a dispute.
     *         FavorClient  -> full refund to client
     *         FavorAgent   -> full payout to agent(s)
     *         Split        -> 50/50
     */
    function resolveDispute(
        uint256 disputeId,
        DisputeOutcome outcome
    ) external onlyOwner nonReentrant {
        require(outcome != DisputeOutcome.Pending, "Invalid outcome");

        Dispute storage d = disputes[disputeId];
        require(d.outcome == DisputeOutcome.Pending, "Already resolved");

        d.outcome = outcome;
        d.resolvedAt = block.timestamp;

        uint256 jobId = d.jobId;
        uint256 escrowed = jobEscrow[jobId];
        jobEscrow[jobId] = 0;

        jobs[jobId].status = JobStatus.Resolved;

        if (outcome == DisputeOutcome.FavorClient) {
            pendingWithdrawals[jobs[jobId].client] += escrowed;
            emit EscrowRefunded(jobId, escrowed);
        } else if (outcome == DisputeOutcome.FavorAgent) {
            _distributePayment(jobId, escrowed);
            emit EscrowReleased(jobId, escrowed);
        } else {
            // Split
            uint256 half = escrowed / 2;
            pendingWithdrawals[jobs[jobId].client] += half;
            _distributePayment(jobId, escrowed - half);
            emit EscrowRefunded(jobId, half);
            emit EscrowReleased(jobId, escrowed - half);
        }

        emit DisputeResolved(disputeId, outcome);
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    function setPlatformFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 1000, "Fee too high"); // max 10 %
        platformFeeBps = _feeBps;
        emit PlatformFeeUpdated(_feeBps);
    }

    function setFeeRecipient(address _recipient) external onlyOwner {
        require(_recipient != address(0), "Zero address");
        feeRecipient = _recipient;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  View helpers
    // ──────────────────────────────────────────────

    function getAgentCapabilities(uint256 agentId) external view returns (string[] memory) {
        return agents[agentId].capabilities;
    }

    function getJobRequiredCapabilities(uint256 jobId) external view returns (string[] memory) {
        return jobs[jobId].requiredCapabilities;
    }

    function getAgentRating(uint256 agentId) external view returns (uint256 avg, uint256 count) {
        Agent storage a = agents[agentId];
        count = a.ratingCount;
        avg = count > 0 ? a.totalRatingSum / count : 0;
    }

    function getWorkflow(uint256 workflowId)
        external
        view
        returns (
            uint256 id,
            uint256 jobId,
            bool finalized,
            uint256 stepCount
        )
    {
        Workflow storage w = workflows[workflowId];
        return (w.id, w.jobId, w.finalized, w.steps.length);
    }

    function getWorkflowStep(uint256 workflowId, uint256 stepIndex)
        external
        view
        returns (uint256 agentId, uint256 revenueShareBps)
    {
        WorkflowStep storage s = workflows[workflowId].steps[stepIndex];
        return (s.agentId, s.revenueShareBps);
    }

    function getOwnerAgents(address owner) external view returns (uint256[] memory) {
        return ownerAgents[owner];
    }

    function getAgentHiredAgents(uint256 agentId) external view returns (uint256[] memory) {
        return agentHiredAgents[agentId];
    }

    // ──────────────────────────────────────────────
    //  Internal
    // ──────────────────────────────────────────────

    function _releaseEscrow(uint256 jobId) internal {
        uint256 escrowed = jobEscrow[jobId];
        jobEscrow[jobId] = 0;

        _distributePayment(jobId, escrowed);

        emit EscrowReleased(jobId, escrowed);
    }

    /**
     * @dev Distributes `amount` among workflow agents (if workflow exists)
     *      or to the single assigned agent, after deducting platform fee.
     *      Uses pull-based pattern (credits pendingWithdrawals) to prevent
     *      griefing by malicious recipient contracts that revert on receive.
     */
    function _distributePayment(uint256 jobId, uint256 amount) internal {
        if (amount == 0) return;

        // Platform fee
        uint256 fee = (amount * platformFeeBps) / 10_000;
        uint256 payout = amount - fee;

        if (fee > 0) {
            pendingWithdrawals[feeRecipient] += fee;
        }

        uint256 wfId = jobWorkflow[jobId];

        if (wfId != 0) {
            // Revenue sharing across workflow steps
            Workflow storage w = workflows[wfId];
            uint256 distributed;

            for (uint256 i = 0; i < w.steps.length; i++) {
                uint256 share;
                if (i == w.steps.length - 1) {
                    // Last agent gets remainder to avoid dust
                    share = payout - distributed;
                } else {
                    share = (payout * w.steps[i].revenueShareBps) / 10_000;
                }
                distributed += share;
                address agentOwner = agents[w.steps[i].agentId].owner;
                pendingWithdrawals[agentOwner] += share;
            }
        } else {
            // Single agent payout
            address agentOwner = agents[jobs[jobId].assignedAgentId].owner;
            pendingWithdrawals[agentOwner] += payout;
        }
    }

    // Only accept ETH via postJob (payable function). No bare transfers.
    receive() external payable {
        revert("Use postJob to deposit");
    }
}
