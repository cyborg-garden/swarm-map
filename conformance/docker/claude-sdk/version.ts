// Prints what the SDK in this image says it is: the version of the package on
// disk and the version the Claude Code program beside it reports. The rig
// runs this in the cell image, with no network, before it starts any cell.
import { loadClaudeSdk } from '../../../lib/runtimes/claude-sdk/load.ts'
import { claudeSdkEnv } from '../../../lib/runtimes/claude-sdk/shim.ts'

const sdk = await loadClaudeSdk('/opt/claude-sdk')
console.log(await sdk.version(claudeSdkEnv({ homeDir: '/tmp', modelBaseUrl: 'http://door:1/v1', placeholder: 'PLACEHOLDER-none' })))
