import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'
import { chmodSync } from 'fs'
import slugify from 'slugify'

// Return local path to donwloaded or cached CLI
async function mcodeCLI(): Promise<string> {
  // Get latest version from API
  let cliVersion = 'latest'
  let os = 'Linux'
  let bin = 'mayhem'

  // Return cache if available
  const cachedPath = tc.find(bin, cliVersion, os)
  if (cachedPath) {
    core.debug(`found cache: ${cachedPath}`)
    return `${cachedPath}/${bin}`
  }

  // Download the CLI and cache it if version is set
  const mcodePath = await tc.downloadTool(
    `https://mayhem.forallsecure.com/cli/${os}/${bin}`
  )
  chmodSync(mcodePath, 0o755)
  // if (cliVersion === 'latest') {
  //   return mcodePath
  // }

  const folder = await tc.cacheFile(mcodePath, bin, bin, cliVersion, os)
  return `${folder}/${bin}`
}

async function run(): Promise<void> {
  try {
    // Disable auto udpates since we always get the latest CLI
    process.env['SKIP_MAPI_AUTO_UPDATE'] = 'true'
    const cli = await mcodeCLI()

    // Load inputs
    const mayhemToken: string = core.getInput('mayhem-token', { required: true })
    const mayhemUrl: string = core.getInput('mayhem-url', { required: true })
    const duration: string = core.getInput('duration', { required: true })
    const sarifReport: string | undefined = core.getInput('sarif-report')
    const htmlReport: string | undefined = core.getInput('html-report')

    // Auto-generate target name
    const repo = process.env['GITHUB_REPOSITORY']
    if (repo === undefined) {
      throw Error(
        'Missing GITHUB_REPOSITORY environment variable. Are you not running this in a Github Action environement?'
      )
    }

    const script = core.getInput('mayhem-script', { required: false })

    process.env['MAYHEM_TOKEN'] = mayhemToken
    process.env['MAYHEM_URL'] = mayhemUrl
    process.env['MAYHEM_PROJECt'] = repo

    // We expect the token to be a service account which can only belong to a
    // single organization, therefore we do not need to specify the org
    // explicitely here. We also ignore failure since we might have created the
    // target in a previous run.
    // await exec.exec(cli, ['target', 'create', apiName, apiUrl], {
    //   ignoreReturnCode: true
    // })
    // Start fuzzing
    const cliRunning = exec.exec("bash", ["-c", script], { ignoreReturnCode: true })
    // cliRunning.stdout.on('data', (data: string) => core.debug(data))
    // cliRunning.stderr.on('data', (data: string) => core.debug(data))
    const res = await cliRunning
    if (res !== 0) {
      // TODO: should we print issues here?
      throw new Error('The Mayhem for Code scan found issues in the Target')
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      core.info(`mcode action failed with: ${err.message}`)
      core.setFailed(err.message)
    }
  }
}

run()
