// One wording for a key's monthly budget, used by every form and table that
// shows it. The number is stored and returned by
// GET /api/harnesses/:id/policy?action=budget-check, but nothing Swarm Map
// ships acts on that answer, so no label may suggest a cap.
export const BUDGET_LABEL = 'Budget ($/mo, not enforced)'
export const BUDGET_HINT =
  'A note for your own tracking. Nothing stops or slows an agent that spends more than this.'
