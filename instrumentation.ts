// Next.js instrumentation hook — runs once per server start.
// Registers the fleet SQLite integrity sweep scheduler (#204, PR1) and the
// state.db snapshot exporter for volume-migrated harnesses (#204, PR2).
export async function register() {
  // Only the Node.js server runtime can touch better-sqlite3 / the filesystem.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { migrateLegacyImageRefs } = await import('@/lib/services/image-migration')
  migrateLegacyImageRefs()
  const { startIntegrityScheduler } = await import('@/lib/services/integrity-scheduler')
  startIntegrityScheduler()
  const { startDbSnapshotScheduler } = await import('@/lib/services/db-snapshot-scheduler')
  startDbSnapshotScheduler()
  // Model freshness / "track newest version" check (off until
  // settings.modelAutoUpdate.enabled; report-only unless mode is 'apply').
  const { startModelUpdateScheduler } = await import('@/lib/services/model-update-scheduler')
  await startModelUpdateScheduler()
}
