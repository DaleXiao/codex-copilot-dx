import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectPackageUpdateEnvironment } from './package-update.mjs';
import { downloadRelease, createNpmReleaseFetch, protectInstallation, stableVersion, writePrivateLaunchers, privateUnixLauncher, remoteDownloadDenied } from './release-install.mjs';
import { inspectWindowsCommand } from './windows-command.mjs';
import { isVersionGreater } from './version.mjs';
import { readBoundedResponseText } from './upstream-body.mjs';
import { readBoundedFileSync } from './bounded-file.mjs';

const run = promisify(execFile);
export const NIGHTLY_IDLE_MS = 10 * 60 * 1000;
export function nightlyWindow(now) { return now.getHours() < 4; }
export function nightlyDay(now) { return `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`; }
export function eligiblePatch(current, release, now = Date.now()) {
  const version = stableVersion(release?.version), before = stableVersion(current), published = Date.parse(release?.published_at);
  return Boolean(before && version && isVersionGreater(version, before) && version.split('.').slice(0,2).join('.') === before.split('.').slice(0,2).join('.')
    && Number.isFinite(published) && now - published >= 24 * 60 * 60 * 1000);
}
export function installedUpdateEnvironment(options = {}) {
  const environment = inspectPackageUpdateEnvironment(options);
  if (environment.state !== 'matched') throw new Error('installation_not_owned');
  fs.accessSync(path.dirname(environment.target), fs.constants.W_OK);
  const windows = (options.platform || process.platform) === 'win32';
  const cli = windows ? path.win32.join(path.win32.dirname(environment.npm), 'node_modules/npm/bin/npm-cli.js') : fs.realpathSync(environment.npm);
  if (!fs.statSync(cli).isFile()) throw new Error('npm_unavailable');
  if (windows) {
    if (inspectWindowsCommand({ packageRoot: environment.target }).status !== 'ready') throw new Error('command_not_owned');
  } else {
    const privateInstall = options.env?.CCDX_PRIVATE_INSTALL_PREFIX || process.env.CCDX_PRIVATE_INSTALL_PREFIX;
    for (const name of ['ccdx','codex-copilot-dx']) {
      const file = path.join(environment.prefix,'bin',name);
      if (privateInstall && path.resolve(privateInstall) === path.resolve(environment.prefix)) {
        if (readBoundedFileSync(file,{encoding:'utf8',maxBytes:16384}) !== privateUnixLauncher({...environment,name})) throw new Error('command_not_owned');
      } else if (fs.realpathSync(file) !== fs.realpathSync(path.join(environment.target,'bin',name === 'ccdx' ? 'cli.mjs' : 'codex-copilot-dx.mjs'))) throw new Error('command_not_owned');
    }
  }
  return { ...environment, npmCli: cli };
}
export async function lookupNightlyRelease(fetchImpl, { signal } = {}) {
  const response = await fetchImpl('https://api.github.com/repos/DaleXiao/codex-copilot-dx/releases/latest', {
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(10000)]), redirect:'error',
    headers:{Accept:'application/vnd.github+json','User-Agent':'codex-copilot-dx'},
  });
  if (!response.ok) { await response.body?.cancel();throw new Error('release_unavailable'); }
  const value = JSON.parse(await readBoundedResponseText(response,{maxBytes:128*1024,signal,label:'Release metadata'}));
  const version = stableVersion(value.tag_name);
  if (!version || value.draft !== false || value.prerelease !== false || !Number.isFinite(Date.parse(value.published_at))) throw new Error('release_invalid');
  return {version,published_at:value.published_at};
}
export async function verifyNightlyRuntime(target, version, { signal, brokerRequired = false } = {}) {
  const program = `const {createRequire}=require('node:module');const r=createRequire(${JSON.stringify(path.join(target,'package.json'))});const p=r('./package.json');if(p.name!=='codex-copilot-dx'||p.version!==${JSON.stringify(version)})throw Error('version');r('sharp')({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer().then(()=>{${brokerRequired?"if(!r('@azure/msal-node-runtime').msalNodeRuntime)throw Error('broker');":''}}).catch(()=>process.exitCode=1);`;
  await run(process.execPath,['-e',program],{signal,timeout:30000,maxBuffer:65536,windowsHide:true});
  const {stdout}=await run(process.execPath,[path.join(target,'bin/cli.mjs'),'version'],{signal,timeout:15000,maxBuffer:65536,windowsHide:true});
  if (!stdout.includes(`ccdx v${version} `)) throw new Error('command_version_invalid');
}
export function nightlyRuntimeRoot({home=os.homedir()}={}) { return path.join(home,'.local/share/codex-copilot-dx/runtime'); }
export async function prepareNightlyRelease(release, { environment, root=nightlyRuntimeRoot(), env=process.env, signal,
  fetchImpl=createNpmReleaseFetch(environment.npmCli,{env}), execute=run, verify=verifyNightlyRuntime }={}) {
  const version=stableVersion(release?.version);if(!version)throw new Error('release_invalid');
  fs.mkdirSync(root,{recursive:true,mode:0o700});const directory=fs.mkdtempSync(path.join(root,'candidate-'));
  const target=path.join(directory,...(process.platform==='win32'?[]:['lib']),'node_modules/codex-copilot-dx');
  const brokerRequired=fs.existsSync(path.join(environment.target,'node_modules/@azure/msal-node-runtime'));
  try {
    let artifact=await downloadRelease(version,{directory,fetchImpl,signal});
    const args=['install','--global','--ignore-scripts','--no-audit','--no-fund'];
    const installArgs=()=>[...args,...(artifact.complete?['--offline']:[])];
    try { await execute(process.execPath,[environment.npmCli,...installArgs(),'--prefix',directory,artifact.file],{env,signal,timeout:300000,maxBuffer:128*1024,windowsHide:true}); }
    catch(error) {
      if(!remoteDownloadDenied(error)||signal?.aborted)throw error;
      artifact=await downloadRelease(version,{directory,fetchImpl,signal,complete:true});
      fs.rmSync(target,{recursive:true,force:true});
      await execute(process.execPath,[environment.npmCli,...installArgs(),'--prefix',directory,artifact.file],{env,signal,timeout:300000,maxBuffer:128*1024,windowsHide:true});
    }
    await verify(target,version,{signal,brokerRequired});
    return { version, target, directory,
      async install() {
        signal?.throwIfAborted();const transaction=protectInstallation(environment);
        try {
          await execute(process.execPath,[environment.npmCli,...installArgs(),'--prefix',environment.prefix,artifact.file],{env,signal,timeout:300000,maxBuffer:128*1024,windowsHide:true});
          await verify(environment.target,version,{signal,brokerRequired});
          const normalize=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
          if(env.CCDX_PRIVATE_INSTALL_PREFIX&&normalize(env.CCDX_PRIVATE_INSTALL_PREFIX)===normalize(environment.prefix))await writePrivateLaunchers(environment);
          if (process.platform==='win32') {
            const {inspectWindowsCommand}=await import(new URL('./windows-command.mjs',import.meta.url));
            if(inspectWindowsCommand({packageRoot:environment.target,repair:true}).status!=='ready')throw new Error('command_setup_failed');
          }
          return transaction;
        }catch(error){transaction.rollback();throw error;}
      },
      cleanup(){fs.rmSync(directory,{recursive:true,force:true});},
    };
  }catch(error){fs.rmSync(directory,{recursive:true,force:true});throw error;}
}
// The foreground supervisor keeps its workers on immutable package trees, so a
// global npm install cannot replace modules under an in-flight request.
export function retainCurrentRuntime(environment,{root=nightlyRuntimeRoot(),copy=fs.cpSync}={}) {
  fs.mkdirSync(root,{recursive:true,mode:0o700});const directory=fs.mkdtempSync(path.join(root,'current-'));
  const target=path.join(directory,'codex-copilot-dx');
  try {copy(environment.package_root,target,{recursive:true,verbatimSymlinks:true,mode:fs.constants.COPYFILE_FICLONE});return {target,directory,cleanup(){fs.rmSync(directory,{recursive:true,force:true});}};}
  catch(error){fs.rmSync(directory,{recursive:true,force:true});throw error;}
}

export function readNightlyState(file) {
  try {
    const value=JSON.parse(readBoundedFileSync(file,{encoding:'utf8',maxBytes:8192}));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['attempted_day','paused_version'].includes(key))
      ||value.attempted_day!==null&&!/^\d{4}-\d{1,2}-\d{1,2}$/.test(value.attempted_day||'')
      ||value.paused_version!==null&&!stableVersion(value.paused_version))throw new Error('invalid_update_state');
    return value;
  }catch(error){if(error.code==='ENOENT')return {attempted_day:null,paused_version:null};throw error;}
}
