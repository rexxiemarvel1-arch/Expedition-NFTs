;; FundingContract.clar
;; Core funding contract for Expedition NFTs project
;; Manages crowdfunding campaigns for real-world expeditions with milestone-based fund releases
;; Integrates with governance for approvals, oracle for verifications, and treasury for fund management

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-CAMPAIGN-NOT-FOUND u101)
(define-constant ERR-CAMPAIGN-ACTIVE u102)
(define-constant ERR-CAMPAIGN-INACTIVE u103)
(define-constant ERR-INVALID-AMOUNT u104)
(define-constant ERR-INVALID-MILESTONE u105)
(define-constant ERR-MILESTONE-NOT-REACHED u106)
(define-constant ERR-FUNDS-LOCKED u107)
(define-constant ERR-DEADLINE-PASSED u108)
(define-constant ERR-ALREADY-CLAIMED u109)
(define-constant ERR-INVALID-PARAM u110)
(define-constant ERR-PAUSED u111)
(define-constant ERR-NOT-APPROVED u112)
(define-constant ERR-MAX-MILESTONES u113)
(define-constant ERR-INVALID-PERCENTAGE u114)
(define-constant ERR-INSUFFICIENT-FUNDS u115)

(define-constant MAX-MILESTONES u10)
(define-constant MIN-CONTRIBUTION u1000000) ;; 1 STX in microstacks
(define-constant MAX_METADATA_LEN u500)

;; Data Structures
(define-map campaigns
  { campaign-id: uint }
  {
    organizer: principal,
    goal: uint,                ;; Target funding amount in microstacks
    raised: uint,              ;; Current raised amount
    deadline: uint,            ;; Block height deadline
    milestones: (list 10 { description: (string-utf8 200), percentage: uint, verified: bool, released: bool }),
    active: bool,
    approved: bool,            ;; Approved by governance
    paused: bool,
    metadata: (string-utf8 500), ;; Expedition details
    refundable: bool           ;; If failed, allow refunds
  }
)

(define-map contributions
  { campaign-id: uint, contributor: principal }
  { amount: uint, refunded: bool }
)

(define-map milestone-verifications
  { campaign-id: uint, milestone-index: uint }
  { verifier: principal, timestamp: uint, evidence: (string-utf8 200) }
)

(define-data-var next-campaign-id uint u1)

;; Traits (for inter-contract interactions)
(define-trait governance-trait
  (
    (is-approved (uint) (response bool uint))
    (vote-on-campaign (uint principal bool) (response bool uint))
  )
)

(define-trait oracle-trait
  (
    (verify-milestone (uint uint (string-utf8 200)) (response bool uint))
  )
)

(define-trait treasury-trait
  (
    (deposit (uint uint) (response bool uint))
    (release-funds (principal uint) (response bool uint))
    (refund (principal uint uint) (response bool uint))
  )
)

;; Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var governance-contract principal tx-sender)
(define-data-var oracle-contract principal tx-sender)
(define-data-var treasury-contract principal tx-sender)
(define-data-var paused bool false)

;; Private Functions
(define-private (is-owner (caller principal))
  (is-eq caller (var-get contract-owner))
)

(define-private (is-approved-by-governance (campaign-id uint))
  (contract-call? .governance-contract is-approved campaign-id)
)

(define-private (verify-milestone-with-oracle (campaign-id uint) (index uint) (evidence (string-utf8 200)))
  (contract-call? .oracle-contract verify-milestone campaign-id index evidence)
)

(define-private (deposit-to-treasury (campaign-id uint) (amount uint))
  (contract-call? .treasury-contract deposit campaign-id amount)
)

(define-private (release-from-treasury (recipient principal) (amount uint))
  (contract-call? .treasury-contract release-funds recipient amount)
)

(define-private (refund-from-treasury (recipient principal) (campaign-id uint) (amount uint))
  (contract-call? .treasury-contract refund recipient campaign-id amount)
)

(define-private (calculate-milestone-amount (raised uint) (percentage uint))
  (/ (* raised percentage) u100)
)

(define-private (validate-milestone-percentages (milestones (list 10 { description: (string-utf8 200), percentage: uint, verified: bool, released: bool })))
  (is-eq (fold + (map get-percentage milestones) u0) u100)
)

(define-private (get-percentage (milestone { description: (string-utf8 200), percentage: uint, verified: bool, released: bool }))
  (get percentage milestone)
)

;; Public Functions
(define-public (set-contract-references (governance principal) (oracle principal) (treasury principal))
  (if (is-owner tx-sender)
    (begin
      (var-set governance-contract governance)
      (var-set oracle-contract oracle)
      (var-set treasury-contract treasury)
      (ok true)
    )
    (err ERR-UNAUTHORIZED)
  )
)

(define-public (pause-contract)
  (if (is-owner tx-sender)
    (begin
      (var-set paused true)
      (ok true)
    )
    (err ERR-UNAUTHORIZED)
  )
)

(define-public (unpause-contract)
  (if (is-owner tx-sender)
    (begin
      (var-set paused false)
      (ok true)
    )
    (err ERR-UNAUTHORIZED)
  )
)

(define-public (create-campaign 
  (goal uint) 
  (deadline uint) 
  (milestones (list 10 { description: (string-utf8 200), percentage: uint, verified: bool, released: bool })) 
  (metadata (string-utf8 500))
  (refundable bool))
  (let
    (
      (campaign-id (var-get next-campaign-id))
      (initialized-milestones (map initialize-milestone milestones))
    )
    (if (or 
          (var-get paused) 
          (<= goal u0) 
          (<= deadline block-height) 
          (> (len milestones) MAX-MILESTONES) 
          (not (validate-milestone-percentages initialized-milestones))
          (> (len metadata) MAX_METADATA_LEN))
      (err ERR-INVALID-PARAM)
      (begin
        (map-set campaigns 
          { campaign-id: campaign-id }
          {
            organizer: tx-sender,
            goal: goal,
            raised: u0,
            deadline: deadline,
            milestones: initialized-milestones,
            active: true,
            approved: false,
            paused: false,
            metadata: metadata,
            refundable: refundable
          }
        )
        (var-set next-campaign-id (+ campaign-id u1))
        (print { event: "campaign-created", id: campaign-id, organizer: tx-sender })
        (ok campaign-id)
      )
    )
  )
)

(define-private (initialize-milestone (milestone { description: (string-utf8 200), percentage: uint, verified: bool, released: bool }))
  (merge milestone { verified: false, released: false })
)

(define-public (approve-campaign (campaign-id uint))
  (let ((campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) (err ERR-CAMPAIGN-NOT-FOUND))))
    (if (and (not (get approved campaign)) (is-ok (is-approved-by-governance campaign-id)))
      (begin
        (map-set campaigns { campaign-id: campaign-id } (merge campaign { approved: true }))
        (print { event: "campaign-approved", id: campaign-id })
        (ok true)
      )
      (err ERR-NOT-APPROVED)
    )
  )
)

(define-public (contribute (campaign-id uint) (amount uint))
  (let ((campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) (err ERR-CAMPAIGN-NOT-FOUND))))
    (if (or 
          (var-get paused) 
          (not (get active campaign)) 
          (not (get approved campaign)) 
          (>= block-height (get deadline campaign)) 
          (< amount MIN-CONTRIBUTION))
      (err ERR-INVALID-PARAM)
      (begin
        (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
        (try! (as-contract (deposit-to-treasury campaign-id amount)))
        (let ((new-raised (+ (get raised campaign) amount))
              (current-contrib (default-to { amount: u0, refunded: false } (map-get? contributions { campaign-id: campaign-id, contributor: tx-sender }))))
          (map-set campaigns { campaign-id: campaign-id } (merge campaign { raised: new-raised }))
          (map-set contributions { campaign-id: campaign-id, contributor: tx-sender } 
            { amount: (+ (get amount current-contrib) amount), refunded: false })
          (print { event: "contribution", id: campaign-id, contributor: tx-sender, amount: amount })
          (ok true)
        )
      )
    )
  )
)

(define-public (verify-milestone (campaign-id uint) (index uint) (evidence (string-utf8 200)))
  (let ((campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) (err ERR-CAMPAIGN-NOT-FOUND)))
        (milestones (get milestones campaign))
        (milestone (unwrap! (element-at? milestones index) (err ERR-INVALID-MILESTONE))))
    (if (or (var-get paused) (not (get active campaign)) (get verified milestone) (is-err (verify-milestone-with-oracle campaign-id index evidence)))
      (err ERR-MILESTONE-NOT-REACHED)
      (begin
        (let ((updated-milestone (merge milestone { verified: true }))
              (updated-milestones (unwrap! (replace-at? milestones index updated-milestone) (err ERR-INVALID-MILESTONE))))
          (map-set campaigns { campaign-id: campaign-id } (merge campaign { milestones: updated-milestones }))
          (map-set milestone-verifications 
            { campaign-id: campaign-id, milestone-index: index } 
            { verifier: tx-sender, timestamp: block-height, evidence: evidence })
          (print { event: "milestone-verified", id: campaign-id, index: index })
          (ok true)
        )
      )
    )
  )
)

(define-public (release-milestone-funds (campaign-id uint) (index uint))
  (let ((campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) (err ERR-CAMPAIGN-NOT-FOUND)))
        (milestones (get milestones campaign))
        (milestone (unwrap! (element-at? milestones index) (err ERR-INVALID-MILESTONE))))
    (if (or (var-get paused) (not (get active campaign)) (not (get verified milestone)) (get released milestone))
      (err ERR-MILESTONE-NOT-REACHED)
      (let ((release-amount (calculate-milestone-amount (get raised campaign) (get percentage milestone)))
            (updated-milestone (merge milestone { released: true }))
            (updated-milestones (unwrap! (replace-at? milestones index updated-milestone) (err ERR-INVALID-MILESTONE))))
        (if (< release-amount u1)
          (err ERR-INSUFFICIENT-FUNDS)
          (begin
            (try! (as-contract (release-from-treasury (get organizer campaign) release-amount)))
            (map-set campaigns { campaign-id: campaign-id } (merge campaign { milestones: updated-milestones }))
            (print { event: "funds-released", id: campaign-id, index: index, amount: release-amount })
            (ok true)
          )
        )
      )
    )
  )
)

(define-public (end-campaign (campaign-id uint))
  (let ((campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) (err ERR-CAMPAIGN-NOT-FOUND))))
    (if (or (var-get paused) (not (get active campaign)) (and (is-eq tx-sender (get organizer campaign)) (>= block-height (get deadline campaign))))
      (begin
        (map-set campaigns { campaign-id: campaign-id } (merge campaign { active: false }))
        (print { event: "campaign-ended", id: campaign-id, success: (>= (get raised campaign) (get goal campaign)) })
        (ok true)
      )
      (err ERR-CAMPAIGN-ACTIVE)
    )
  )
)

(define-public (claim-refund (campaign-id uint))
  (let ((campaign (unwrap! (map-get? campaigns { campaign-id: campaign-id }) (err ERR-CAMPAIGN-NOT-FOUND)))
        (contrib (unwrap! (map-get? contributions { campaign-id: campaign-id, contributor: tx-sender }) (err ERR-UNAUTHORIZED))))
    (if (or (var-get paused) (get active campaign) (not (get refundable campaign)) (>= (get raised campaign) (get goal campaign)) (get refunded contrib))
      (err ERR-FUNDS-LOCKED)
      (begin
        (try! (as-contract (refund-from-treasury tx-sender campaign-id (get amount contrib))))
        (map-set contributions { campaign-id: campaign-id, contributor: tx-sender } (merge contrib { refunded: true }))
        (print { event: "refund-claimed", id: campaign-id, contributor: tx-sender, amount: (get amount contrib) })
        (ok true)
      )
    )
  )
)

;; Read-Only Functions
(define-read-only (get-campaign-details (campaign-id uint))
  (map-get? campaigns { campaign-id: campaign-id })
)

(define-read-only (get-contribution (campaign-id uint) (contributor principal))
  (map-get? contributions { campaign-id: campaign-id, contributor: contributor })
)

(define-read-only (get-milestone-verification (campaign-id uint) (index uint))
  (map-get? milestone-verifications { campaign-id: campaign-id, milestone-index: index })
)

(define-read-only (get-next-campaign-id)
  (var-get next-campaign-id)
)

(define-read-only (is-paused)
  (var-get paused)
)