import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as tc from '@actions/tool-cache'
import {chmodSync} from 'fs'

// Return local path to donwloaded or cached CLI
async function mcodeCLI(): Promise<string> {
  // Get latest version from API
  const cliVersion = 'latest'
  const os = 'Linux'
  const bin = 'mayhem'

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
  const folder = await tc.cacheFile(mcodePath, bin, bin, cliVersion, os)
  return `${folder}/${bin}`
}

async function run(): Promise<void> {
  try {
    // Disable auto udpates since we always get the latest CLI
    process.env['SKIP_MAPI_AUTO_UPDATE'] = 'true'
    const cli = await mcodeCLI()

    // Load inputs
    const mayhemUrl: string = core.getInput('mayhem-url', {required: true})
    const githubToken: string | undefined = core.getInput('github-token')
    const mayhemToken: string = core.getInput('mayhem-token', {required: true})
    const sarifOutput: string = core.getInput('sarif-output') || 'mayhem-out/sarif'
    const args: string[] = (core.getInput('args') || '').split(' ')
    // substitution first
    if (!args.includes('--image')) {
      args[args.indexOf('--image')] = '--baseimage'
    }

    // defaults next
    if (!args.includes('--duration')) {
      args.push('--duration', '30')
    }
    if (!args.includes('--baseimage')) {
      args.push('--baseimage', 'forallsecure/debian-buster:latest')
    }
    const argsString = args.join(' ')

    // Auto-generate target name
    const repo = process.env['GITHUB_REPOSITORY']
    const account = repo?.split('/')[0].toLowerCase()
    if (repo === undefined) {
      throw Error(
        'Missing GITHUB_REPOSITORY environment variable. Are you not running this in a Github Action environement?'
      )
    }
    // decide on the application type

    const script = `
    mkdir -p ${sarifOutput};
    is_rust=$(cargo fuzz list);
    if [ -n "$is_rust" ]; then
      for fuzz_target in $is_rust; do
        echo $fuzz_target;
        cargo fuzz build $fuzz_target;
        for path in $(ls fuzz/target/*/*/$fuzz_target); do
          ${cli} package $path -o $fuzz_target;
          rm -rf $fuzz_target/root/lib;
          [[ -e fuzz/corpus/$fuzz_target ]] && cp fuzz/corpus/$fuzz_target/* $fuzz_target/corpus/;
          sed -i 's,project: .*,project: ${repo.toLowerCase()},g' $fuzz_target/Mayhemfile;
          echo ${cli} run $fuzz_target --corpus file://$(pwd)/$fuzz_target/corpus ${argsString};
          run=$(${cli} run $fuzz_target --corpus file://$(pwd)/$fuzz_target/corpus ${argsString});
          ${cli} wait $run -n ${account} --sarif ${sarifOutput}/$fuzz_target.sarif;
          [[ "$(${cli} show $run -n ${account} | grep Defects | cut -f 2 -d :)" == " 0" ]];
        done
      done
    else
      echo ${cli} run . ${argsString};
      run=$(${cli} run . ${argsString});
      ${cli} wait $run -n ${account} --sarif ${sarifOutput}/target.sarif;
      [[ "$(${cli} show $run -n ${account} | grep Defects | cut -f 2 -d :)" == " 0" ]];
    fi
`
    if (githubToken !== undefined) {
      const octokit = github.getOctokit(githubToken)
      const context = github.context
      const {pull_request} = context.payload
      if (pull_request !== undefined) {
        await octokit.rest.issues.createComment({
          ...context.repo,
          issue_number: pull_request.number,
          body: `# Mayhem for Code

          Mayhem is taking a look at this PR and will post results in checks.
          `
        })
      }
      core.debug(`${octokit}`)
    }

    process.env['MAYHEM_TOKEN'] = mayhemToken
    process.env['MAYHEM_URL'] = mayhemUrl
    process.env['MAYHEM_PROJECt'] = repo

    // Start fuzzing
    const cliRunning = exec.exec('bash', ['-c', script], {
      ignoreReturnCode: true
    })
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
