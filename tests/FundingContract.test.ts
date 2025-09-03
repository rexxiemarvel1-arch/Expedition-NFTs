import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Milestone {
  description: string;
  percentage: number;
  verified: boolean;
  released: boolean;
}

interface Campaign {
  organizer: string;
  goal: number;
  raised: number;
  deadline: number;
  milestones: Milestone[];
  active: boolean;
  approved: boolean;
  paused: boolean;
  metadata: string;
  refundable: boolean;
}

interface Contribution {
  amount: number;
  refunded: boolean;
}

interface MilestoneVerification {
  verifier: string;
  timestamp: number;
  evidence: string;
}

interface ContractState {
  campaigns: Map<number, Campaign>;
  contributions: Map<string, Contribution>;
  milestoneVerifications: Map<string, MilestoneVerification>;
  nextCampaignId: number;
  paused: boolean;
  contractOwner: string;
  governanceContract: string;
  oracleContract: string;
  treasuryContract: string;
  blockHeight: number;
  stxTransfers: Array<{ amount: number; sender: string; recipient: string }>;
}

// Mock contract implementation
class FundingContractMock {
  private state: ContractState = {
    campaigns: new Map(),
    contributions: new Map(),
    milestoneVerifications: new Map(),
    nextCampaignId: 1,
    paused: false,
    contractOwner: "deployer",
    governanceContract: "governance",
    oracleContract: "oracle",
    treasuryContract: "treasury",
    blockHeight: 1000,
    stxTransfers: [],
  };

  private ERR_UNAUTHORIZED = 100;
  private ERR_CAMPAIGN_NOT_FOUND = 101;
  private ERR_CAMPAIGN_ACTIVE = 102;
  private ERR_INVALID_PARAM = 110;
  private ERR_NOT_APPROVED = 112;
  private ERR_INVALID_MILESTONE = 105;
  private ERR_MILESTONE_NOT_REACHED = 106;
  private ERR_INSUFFICIENT_FUNDS = 115;
  private ERR_PAUSED = 111;
  private ERR_FUNDS_LOCKED = 107;
  private MAX_MILESTONES = 10;
  private MIN_CONTRIBUTION = 1000000;
  private MAX_METADATA_LEN = 500;

  // Mock dependencies
  private governanceMock = {
    isApproved: vi.fn(),
    voteOnCampaign: vi.fn(),
  };

  private oracleMock = {
    verifyMilestone: vi.fn(),
  };

  private treasuryMock = {
    deposit: vi.fn(),
    releaseFunds: vi.fn(),
    refund: vi.fn(),
  };

  constructor() {
    this.governanceMock.isApproved.mockImplementation((campaignId: number) =>
      campaignId === 1 ? { ok: true, value: true } : { ok: true, value: false }
    );
    this.oracleMock.verifyMilestone.mockImplementation(() => ({ ok: true, value: true }));
    this.treasuryMock.deposit.mockImplementation(() => ({ ok: true, value: true }));
    this.treasuryMock.releaseFunds.mockImplementation(() => ({ ok: true, value: true }));
    this.treasuryMock.refund.mockImplementation(() => ({ ok: true, value: true }));
  }

  setBlockHeight(height: number) {
    this.state.blockHeight = height;
  }

  isPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getNextCampaignId(): ClarityResponse<number> {
    return { ok: true, value: this.state.nextCampaignId };
  }

  getCampaignDetails(campaignId: number): ClarityResponse<Campaign | null> {
    return { ok: true, value: this.state.campaigns.get(campaignId) ?? null };
  }

  getContribution(campaignId: number, contributor: string): ClarityResponse<Contribution | null> {
    return { ok: true, value: this.state.contributions.get(`${campaignId}-${contributor}`) ?? null };
  }

  getMilestoneVerification(campaignId: number, index: number): ClarityResponse<MilestoneVerification | null> {
    return { ok: true, value: this.state.milestoneVerifications.get(`${campaignId}-${index}`) ?? null };
  }

  setContractReferences(caller: string, governance: string, oracle: string, treasury: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.governanceContract = governance;
    this.state.oracleContract = oracle;
    this.state.treasuryContract = treasury;
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  createCampaign(
    caller: string,
    goal: number,
    deadline: number,
    milestones: Milestone[],
    metadata: string,
    refundable: boolean
  ): ClarityResponse<number> {
    if (
      this.state.paused ||
      goal <= 0 ||
      deadline <= this.state.blockHeight ||
      milestones.length > this.MAX_MILESTONES ||
      metadata.length > this.MAX_METADATA_LEN ||
      milestones.reduce((sum, m) => sum + m.percentage, 0) !== 100
    ) {
      return { ok: false, value: this.ERR_INVALID_PARAM };
    }
    const campaignId = this.state.nextCampaignId;
    this.state.campaigns.set(campaignId, {
      organizer: caller,
      goal,
      raised: 0,
      deadline,
      milestones: milestones.map(m => ({ ...m, verified: false, released: false })),
      active: true,
      approved: false,
      paused: false,
      metadata,
      refundable,
    });
    this.state.nextCampaignId += 1;
    return { ok: true, value: campaignId };
  }

  approveCampaign(caller: string, campaignId: number): ClarityResponse<boolean> {
    const campaign = this.state.campaigns.get(campaignId);
    if (!campaign) {
      return { ok: false, value: this.ERR_CAMPAIGN_NOT_FOUND };
    }
    if (campaign.approved || !this.governanceMock.isApproved(campaignId).value) {
      return { ok: false, value: this.ERR_NOT_APPROVED };
    }
    this.state.campaigns.set(campaignId, { ...campaign, approved: true });
    return { ok: true, value: true };
  }

  contribute(caller: string, campaignId: number, amount: number): ClarityResponse<boolean> {
    const campaign = this.state.campaigns.get(campaignId);
    if (!campaign) {
      return { ok: false, value: this.ERR_CAMPAIGN_NOT_FOUND };
    }
    if (
      this.state.paused ||
      !campaign.active ||
      !campaign.approved ||
      this.state.blockHeight >= campaign.deadline ||
      amount < this.MIN_CONTRIBUTION
    ) {
      return { ok: false, value: this.ERR_INVALID_PARAM };
    }
    this.state.stxTransfers.push({ amount, sender: caller, recipient: "contract" });
    this.treasuryMock.deposit(campaignId, amount);
    const newRaised = campaign.raised + amount;
    const key = `${campaignId}-${caller}`;
    const currentContrib = this.state.contributions.get(key) ?? { amount: 0, refunded: false };
    this.state.campaigns.set(campaignId, { ...campaign, raised: newRaised });
    this.state.contributions.set(key, { amount: currentContrib.amount + amount, refunded: false });
    return { ok: true, value: true };
  }

  verifyMilestone(caller: string, campaignId: number, index: number, evidence: string): ClarityResponse<boolean> {
    const campaign = this.state.campaigns.get(campaignId);
    if (!campaign || index >= campaign.milestones.length) {
      return { ok: false, value: this.ERR_INVALID_MILESTONE };
    }
    const milestone = campaign.milestones[index];
    if (this.state.paused || !campaign.active || milestone.verified || !this.oracleMock.verifyMilestone(campaignId, index, evidence).value) {
      return { ok: false, value: this.ERR_MILESTONE_NOT_REACHED };
    }
    campaign.milestones[index] = { ...milestone, verified: true };
    this.state.campaigns.set(campaignId, campaign);
    this.state.milestoneVerifications.set(`${campaignId}-${index}`, { verifier: caller, timestamp: this.state.blockHeight, evidence });
    return { ok: true, value: true };
  }

  releaseMilestoneFunds(caller: string, campaignId: number, index: number): ClarityResponse<boolean> {
    const campaign = this.state.campaigns.get(campaignId);
    if (!campaign || index >= campaign.milestones.length) {
      return { ok: false, value: this.ERR_INVALID_MILESTONE };
    }
    const milestone = campaign.milestones[index];
    if (this.state.paused || !campaign.active || !milestone.verified || milestone.released) {
      return { ok: false, value: this.ERR_MILESTONE_NOT_REACHED };
    }
    const releaseAmount = Math.floor((campaign.raised * milestone.percentage) / 100);
    if (releaseAmount < 1) {
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }
    this.treasuryMock.releaseFunds(campaign.organizer, releaseAmount);
    campaign.milestones[index] = { ...milestone, released: true };
    this.state.campaigns.set(campaignId, campaign);
    return { ok: true, value: true };
  }

  endCampaign(caller: string, campaignId: number): ClarityResponse<boolean> {
    const campaign = this.state.campaigns.get(campaignId);
    if (!campaign) {
      return { ok: false, value: this.ERR_CAMPAIGN_NOT_FOUND };
    }
    if (this.state.paused || !campaign.active || (caller !== campaign.organizer && this.state.blockHeight < campaign.deadline)) {
      return { ok: false, value: this.ERR_CAMPAIGN_ACTIVE };
    }
    this.state.campaigns.set(campaignId, { ...campaign, active: false });
    return { ok: true, value: true };
  }

  claimRefund(caller: string, campaignId: number): ClarityResponse<boolean> {
    const campaign = this.state.campaigns.get(campaignId);
    const contrib = this.state.contributions.get(`${campaignId}-${caller}`);
    if (!campaign || !contrib) {
      return { ok: false, value: this.ERR_CAMPAIGN_NOT_FOUND };
    }
    if (this.state.paused || campaign.active || !campaign.refundable || campaign.raised >= campaign.goal || contrib.refunded) {
      return { ok: false, value: this.ERR_FUNDS_LOCKED };
    }
    this.treasuryMock.refund(caller, campaignId, contrib.amount);
    this.state.contributions.set(`${campaignId}-${caller}`, { ...contrib, refunded: true });
    return { ok: true, value: true };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  organizer: "organizer",
  contributor: "contributor",
  verifier: "verifier",
};

describe("FundingContract", () => {
    let contract: FundingContractMock;

    beforeEach(() => {
        contract = new FundingContractMock();
        vi.resetAllMocks();
        contract.setBlockHeight(1000);
    });

    // Existing tests remain the same until the failing ones...

    it("should allow contributions to approved campaigns", () => {
        // Setup governance mock to approve campaign 1
        contract.governanceMock.isApproved.mockReturnValue({ ok: true, value: true });
        
        const milestones: Milestone[] = [
            { description: "Start expedition", percentage: 50, verified: false, released: false },
            { description: "Complete research", percentage: 50, verified: false, released: false },
        ];
        
        contract.createCampaign(accounts.organizer, 10000000, 2000, milestones, "Ocean research", true);
        expect(contract.approveCampaign(accounts.organizer, 1)).toEqual({ ok: true, value: true });
        
        const result = contract.contribute(accounts.contributor, 1, 2000000);
        expect(result).toEqual({ ok: true, value: true });
        
        const contribution = contract.getContribution(1, accounts.contributor);
        expect(contribution).toEqual({
            ok: true,
            value: { amount: 2000000, refunded: false },
        });
    });

    it("should prevent contributions to unapproved or expired campaigns", () => {
        // Setup governance mock to reject campaign 2
        contract.governanceMock.isApproved.mockReturnValue({ ok: true, value: false });
        
        const milestones: Milestone[] = [
            { description: "Start expedition", percentage: 50, verified: false, released: false },
            { description: "Complete research", percentage: 50, verified: false, released: false },
        ];
        
        contract.createCampaign(accounts.organizer, 10000000, 2000, milestones, "Ocean research", true);
        expect(contract.contribute(accounts.contributor, 1, 2000000)).toEqual({ ok: false, value: 110 });
    });

    it("should allow milestone verification and fund release", () => {
        // Setup governance mock
        contract.governanceMock.isApproved.mockReturnValue({ ok: true, value: true });
        
        const milestones: Milestone[] = [
            { description: "Start expedition", percentage: 50, verified: false, released: false },
            { description: "Complete research", percentage: 50, verified: false, released: false },
        ];
        
        contract.createCampaign(accounts.organizer, 10000000, 2000, milestones, "Ocean research", true);
        contract.approveCampaign(accounts.organizer, 1);
        contract.contribute(accounts.contributor, 1, 4000000);
        
        // Setup oracle mock
        contract.oracleMock.verifyMilestone.mockReturnValue({ ok: true, value: true });
        
        const verifyResult = contract.verifyMilestone(accounts.verifier, 1, 0, "Evidence");
        expect(verifyResult).toEqual({ ok: true, value: true });
        
        const releaseResult = contract.releaseMilestoneFunds(accounts.organizer, 1, 0);
        expect(releaseResult).toEqual({ ok: true, value: true });
    });

    it("should handle campaign lifecycle completely", () => {
        // Setup mocks
        contract.governanceMock.isApproved.mockReturnValue({ ok: true, value: true });
        contract.oracleMock.verifyMilestone.mockReturnValue({ ok: true, value: true });
        contract.treasuryMock.deposit.mockReturnValue({ ok: true, value: true });
        contract.treasuryMock.releaseFunds.mockReturnValue({ ok: true, value: true });
        
        const milestones: Milestone[] = [
            { description: "Start expedition", percentage: 50, verified: false, released: false },
            { description: "Complete research", percentage: 50, verified: false, released: false },
        ];
        
        // Create and approve campaign
        const createResult = contract.createCampaign(accounts.organizer, 10000000, 2000, milestones, "Ocean research", true);
        expect(createResult.ok).toBe(true);
        expect(contract.approveCampaign(accounts.organizer, 1)).toEqual({ ok: true, value: true });
        
        // Make contributions
        expect(contract.contribute(accounts.contributor, 1, 5000000)).toEqual({ ok: true, value: true });
        
        // Verify and release milestone
        expect(contract.verifyMilestone(accounts.verifier, 1, 0, "Evidence")).toEqual({ ok: true, value: true });
        expect(contract.releaseMilestoneFunds(accounts.organizer, 1, 0)).toEqual({ ok: true, value: true });
        
        // End campaign
        contract.setBlockHeight(2001);
        expect(contract.endCampaign(accounts.organizer, 1)).toEqual({ ok: true, value: true });
    });

    it("should handle failed campaign and refunds", () => {
        // Setup mocks
        contract.governanceMock.isApproved.mockReturnValue({ ok: true, value: true });
        contract.treasuryMock.refund.mockReturnValue({ ok: true, value: true });
        
        const milestones: Milestone[] = [
            { description: "Start expedition", percentage: 100, verified: false, released: false },
        ];
        
        // Create and approve campaign
        contract.createCampaign(accounts.organizer, 10000000, 2000, milestones, "Ocean research", true);
        contract.approveCampaign(accounts.organizer, 1);
        
        // Make partial contribution
        contract.contribute(accounts.contributor, 1, 2000000);
        
        // End campaign (deadline passed)
        contract.setBlockHeight(2001);
        expect(contract.endCampaign(accounts.organizer, 1)).toEqual({ ok: true, value: true });
        
        // Claim refund
        expect(contract.claimRefund(accounts.contributor, 1)).toEqual({ ok: true, value: true });
    });
});
