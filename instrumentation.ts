// Next.js instrumentation hook — runs once per server start.
// Registers the fleet SQLite integrity sweep scheduler (#204, PR1) and the
// state.db snapshot exporter for volume-migrated harnesses (#204, PR2), and
// runs the one-shot .env heals (legacy image refs, Discord thread gate).
export async function register() {
  // Only the Node.js server runtime can touch better-sqlite3 / the filesystem.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // First-run auth bootstrap: without a token the fail-closed middleware 503s
  // every gated request, so a fresh clone is unusable until one exists.
  const { ensureOperatorToken } = await import('@/lib/services/operator-token')
  const operatorToken = ensureOperatorToken()
  if (operatorToken.status === 'generated') {
    // eslint-disable-next-line no-console
    console.log(
      `\n[auth] Generated an operator token → ${operatorToken.path}\n` +
        `[auth] Sign in at /login with the value of HSM_OPERATOR_TOKEN from that file.\n`,
    )
  } else if (operatorToken.status === 'ephemeral') {
    // Couldn't persist — the operator has no other way to learn the token.
    // eslint-disable-next-line no-console
    console.warn(
      `\n[auth] Could not write .env.local (${operatorToken.reason}).\n` +
        `[auth] Set HSM_OPERATOR_TOKEN yourself. This run's token is: ${operatorToken.token}\n`,
    )
  }
  const { migrateLegacyImageRefs } = await import('@/lib/services/image-migration')
  migrateLegacyImageRefs()
  // Discord thread mention gate (2026-10-06): add DISCORD_THREAD_REQUIRE_MENTION
  // =true to Discord agents whose .env lacks it. Never overrides a value.
  const { healFleetDiscordThreadGatesAtStartup } = await import('@/lib/services/discord-thread-gate-fleet')
  healFleetDiscordThreadGatesAtStartup()
  const { syncFleetDiscordApproverRolesAtStartup } = await import('@/lib/services/discord-approver-roles-fleet')
  syncFleetDiscordApproverRolesAtStartup()
  const { syncFleetDiscordAllowedBotRolesAtStartup } = await import('@/lib/services/discord-allowed-bot-roles-fleet')
  syncFleetDiscordAllowedBotRolesAtStartup()
  const { startIntegrityScheduler } = await import('@/lib/services/integrity-scheduler')
  startIntegrityScheduler()
  const { startDbSnapshotScheduler } = await import('@/lib/services/db-snapshot-scheduler')
  startDbSnapshotScheduler()
  // Model freshness / "track newest version" check (off until
  // settings.modelAutoUpdate.enabled; report-only unless mode is 'apply').
  const { startModelUpdateScheduler } = await import('@/lib/services/model-update-scheduler')
  await startModelUpdateScheduler()
}
