// Finds the addresses the probe will try that are not the rig's own. It runs
// in a container on Docker's default network, the one place this machine's
// Docker name resolves and a place with DNS, and prints one line of JSON. No
// harness is in that container. No address is written in this repo.
//
// An address that cannot be found is left empty. The probe then reports that
// way out as not tried, which fails the check: it does not pass untried.
import dns from 'node:dns'
import path from 'node:path'
import type { ProbeTargets } from './compose.ts'

/** The questions asked, so a test can answer them without a network. `server` asks that resolver itself. */
export interface Lookups {
  hostAddress(): Promise<string>
  resolve4(name: string, server?: string): Promise<string[]>
  resolve6(name: string, server?: string): Promise<string[]>
}

const ADDRESS = /^[0-9a-fA-F.:]+$/
const first = (answer: Promise<string[] | string>): Promise<string> =>
  answer.then((a) => (Array.isArray(a) ? a[0] : a) ?? '', () => '').then((a) => (ADDRESS.test(a) ? a : ''))

export async function findAddresses(ask: Lookups): Promise<ProbeTargets> {
  const [hostIp, publicIp, resolverIp] = await Promise.all([
    first(ask.hostAddress()), first(ask.resolve4('example.com')), first(ask.resolve4('one.one.one.one')),
  ])
  let resolverIp6 = await first(ask.resolve6('one.one.one.one'))
  // Some networks answer no IPv6 question at all. The public resolver found above is then asked itself.
  if (resolverIp6 === '' && resolverIp !== '') resolverIp6 = await first(ask.resolve6('one.one.one.one', resolverIp))
  return { hostIp, publicIp, resolverIp, resolverIp6 }
}

const via = (server?: string): dns.promises.Resolver => {
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 })
  if (server) resolver.setServers([server])
  return resolver
}
const real: Lookups = {
  hostAddress: () => dns.promises.lookup('host.docker.internal', { family: 4 }).then((r) => r.address),
  resolve4: (name, server) => via(server).resolve4(name),
  resolve6: (name, server) => via(server).resolve6(name),
}

if (path.resolve(process.argv[1] ?? '') === import.meta.filename) console.log(JSON.stringify(await findAddresses(real)))
