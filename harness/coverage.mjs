// Coverage map for the harness report. Copied from the planning docs (which are not committed):
// invariants from 3-contract.md 3.5 and the T-id -> invariant column of 7-security-tests.md.

export const INVARIANTS = {
  I1: 'For every agent and day: committed spent + reserved <= daily_limit at reservation time; no payment exceeds per_payment_limit',
  I2: 'For the org and day: org_spent + org_reserved <= org_daily_limit at reservation time',
  I3: 'Only allowlisted merchants receive vault USDC from pay',
  I4: 'A payment_id is reserved at most once; a re-broadcast signed transaction is refused by the protocol',
  I5: 'A paused agent, or any agent while org_paused, creates no new reservation',
  I6: 'Only the owner loosens, resumes, registers, refills, revokes, withdraws, upgrades or rotates. The guardian only pauses. Agents only call pay',
  I7: 'Ledger conservation: deposited_total == available + reserved + paid_total + withdrawn_total after every receipt',
  I8: 'available + reserved <= float_cap',
  I9: 'Every pay that passes authorization produces exactly one ring outcome, or stays pending if its callback fails. next_seq == paid + failed + rejected',
  I10: 'A failed transfer returns the full amount to available and to the agent and org headroom',
  I11: 'Every agent FC key has receiver the vault and method list exactly pay; the guardian key exactly pause_agent,pause_all',
  I12: 'ft_on_transfer credits only owner deposits of the pinned token',
};

/** T-id -> invariants (7-security-tests.md). T-ids without an invariant cover balance, precedence, auth or liveness. */
export const T_INVARIANTS = {
  'T-01': ['I3', 'I7', 'I9'], 'T-02': ['I4'], 'T-03': ['I4'], 'T-04': ['I5'], 'T-05': ['I5'], 'T-06': ['I3'], 'T-07': ['I1'], 'T-08': ['I1'],
  'T-09': ['I2'], 'T-12': ['I1', 'I2', 'I7'], 'T-13': ['I1'], 'T-14': ['I2'], 'T-15': ['I1', 'I2'], 'T-16': ['I4'], 'T-18': ['I5'],
  'T-19': ['I5', 'I6'], 'T-20': ['I6'], 'T-21': ['I6', 'I11'], 'T-22': ['I6'], 'T-23': ['I6'], 'T-24': ['I6'], 'T-25': ['I10'], 'T-26': ['I10'],
  'T-27': ['I8'], 'T-28': ['I12'], 'T-29': ['I12'], 'T-30': ['I12'], 'T-31': ['I6', 'I7'], 'T-32': ['I11'], 'T-33': ['I1'], 'T-34': ['I3'],
  'T-35': ['I6'], 'T-37': ['I1', 'I2', 'I7', 'I8', 'I9'], 'T-38': ['I3'], 'T-51': ['I9', 'I10'], 'T-52': ['I6', 'I11'],
};

/** Service and UI test ids (C2 to C6), matched to test names by pattern. */
export const SERVICE_TESTS = [
  { id: 'T-42', title: 'C5 syncer gap', match: /gap/i },
  { id: 'T-43', title: 'C5 counts cross-check', match: /counts mismatch|counts differ|counts_match/i },
  { id: 'T-44', title: 'C5 guardian ops lifecycle', match: /pause op lifecycle|op_in_flight|unresolved|NotEnoughAllowance|InvalidNonce/i },
  { id: 'T-45', title: 'C5 operator auth (cookie, Origin)', match: /(?<![-\w])Origin\b|forged|unauthenticated|bad_origin|sign-ins/ },
  { id: 'T-46', title: 'C5, C6 read-only viewer', match: /viewer/i },
  { id: 'T-47', title: 'C6 no browser credentials, no injectable commands', match: /shell metacharacters|unsafe|not readable from page script|cookie is HttpOnly/i },
  { id: 'T-48', title: 'C6 no fake success (Paused only from state())', match: /until a snapshot shows Paused|only a later snapshot shows Paused|Paused once a snapshot|row is not Paused|chain shows agent 4 paused/i },
  { id: 'C4', title: 'Guardian key startup check (I11 on the server side)', match: /guardian startup check|rejects .*(full access|pay key|receiver|extra method)/i },
];

/** T-ids and explicit invariants named in a test name: t01_t07_t08_basic_limits -> T-01, T-07, T-08; "I7 conservation" -> I7. */
export function tagsOf(name) {
  const tids = new Set();
  const invs = new Set();
  for (const m of name.matchAll(/(?:^|[^a-z0-9])t-?(\d{2})(?=[^0-9]|$)/gi)) tids.add(`T-${m[1]}`);
  for (const m of name.matchAll(/(?:^|[^A-Za-z0-9])[Ii](\d{1,2})(?=[^0-9]|$)/g)) if (INVARIANTS[`I${m[1]}`]) invs.add(`I${m[1]}`);
  for (const t of tids) for (const i of T_INVARIANTS[t] ?? []) invs.add(i);
  return { tids: [...tids], invs: [...invs] };
}
