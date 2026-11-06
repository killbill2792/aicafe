#!/usr/bin/env node
// AWS Ubuntu/XFCE adapter for the existing AI CAFE development browser worker.
// Only sends an owner-approved one-time prompt into an already-signed-in Chrome tab.
// Never reads assistant replies, cookies, browser storage, or provider network traffic.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateAction, prepareLocalState, reserve, markReceipt } from './state.mjs';

export function requireLiveApproval(action, env = process.env) {
  const approved = validateAction(action);
  if (approved.provider !== 'chatgpt')
    throw new Error('Only ChatGPT is enabled: Claude website automation needs provider permission');
  if (env.AICAFE_BROWSER_LIVE_SEND !== '1')
    throw new Error('Live sending is OFF. Set AICAFE_BROWSER_LIVE_SEND=1 only for an approved pilot');
  if (!env.DISPLAY) throw new Error('Run inside the Ubuntu remote desktop Terminal (DISPLAY is missing)');
  return approved;
}

export function parseGeometry(output) {
  const entries = Object.fromEntries(output.trim().split(/\r?\n/).map(line => line.split('=')));
  const rect = Object.fromEntries(['X','Y','WIDTH','HEIGHT'].map(k => [k.toLowerCase(), Number(entries[k])]));
  if (Object.values(rect).some(x => !Number.isSafeInteger(x)) || rect.width < 500 || rect.height < 350)
    throw new Error('Cannot verify Chrome window geometry');
  return rect;
}

export function parseMouse(output) {
  const x = Number(output.match(/(?:^|\s)x:(\d+)/)?.[1]);
  const y = Number(output.match(/(?:^|\s)y:(\d+)/)?.[1]);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error('Cannot read mouse coordinates');
  return { x, y };
}

export function systemRun(executable, args, input, exec = execFileSync) {
  // xclip clipboard writes fork a long-lived owner; inherited stdout/stderr pipes
  // make execFileSync wait indefinitely even after the initial process exits.
  const clipboardWrite = executable === 'xclip' && !args.includes('-o');
  return exec(executable, args, {
    input, encoding: 'utf8', timeout: 12000,
    stdio: clipboardWrite ? ['pipe', 'ignore', 'ignore'] : ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1_000_000,
  }).trim();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function chromeWindow(run) {
  const ids = run('xdotool', ['search','--onlyvisible','--class','google-chrome']).split(/\r?\n/).filter(Boolean);
  if (ids.length !== 1 || !/^\d+$/.test(ids[0]))
    throw new Error('Exactly one visible Chrome window is required; close extra Chrome windows');
  return ids[0];
}
function geometry(run, id) {
  return parseGeometry(run('xdotool', ['getwindowgeometry','--shell',id]));
}
function assertChromeFocused(run, id) {
  if (run('xdotool', ['getactivewindow']).trim() !== id)
    throw new Error('Chrome is no longer the active window; no message sent');
}
function position(calibration, rect) {
  if (calibration?.version !== 1 || calibration.width !== rect.width || calibration.height !== rect.height)
    throw new Error('Chrome window dimensions changed; repeat calibration before sending');
  const x = rect.x + calibration.xOffset, y = rect.y + calibration.yOffset;
  if (![x,y].every(Number.isSafeInteger) || x <= rect.x || x >= rect.x + rect.width ||
      y <= rect.y || y >= rect.y + rect.height)
    throw new Error('Invalid saved composer coordinates');
  return { x, y };
}

export async function calibrate({ run = systemRun, pause: wait = pause, baseDir } = {}) {
  if (!process.env.DISPLAY) throw new Error('Run in the remote desktop Terminal, not an SSH session');
  const state = await prepareLocalState(baseDir);
  const id = chromeWindow(run);
  const before = geometry(run, id);
  console.log('Within five seconds, move your mouse pointer over the EMPTY ChatGPT message editor.');
  await wait(5000);
  const after = geometry(run, id);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Chrome window moved during calibration');
  const pointer = parseMouse(run('xdotool',['getmouselocation']));
  const calibration = { version: 1, width: after.width, height: after.height,
    xOffset: pointer.x - after.x, yOffset: pointer.y - after.y };
  position(calibration, after);
  const file = path.join(path.dirname(state.receipts), 'aws-chrome-editor.json');
  await fs.writeFile(file, JSON.stringify(calibration) + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
  console.log('Composer position saved. This proves only calibration, not message delivery.');
  return calibration;
}

export async function sendOnce(inputAction, { run = systemRun, pause: wait = pause,
  baseDir, env = process.env } = {}) {
  const action = requireLiveApproval(inputAction, env);
  const state = await prepareLocalState(baseDir);
  // Reserve before any browser effect: crashes never automatically replay the same action.
  const receipt = await reserve(state.receipts, action);
  let reachedComposer = false;
  let sessionLock;
  const lockFile = path.join(path.dirname(state.receipts), 'aws-desktop-session.lock');
  try {
    // One shared display/clipboard. A crash leaves the lock to force manual review.
    sessionLock = await fs.open(lockFile, 'wx', 0o600);
    const file = path.join(path.dirname(state.receipts), 'aws-chrome-editor.json');
    const calibration = JSON.parse(await fs.readFile(file, 'utf8'));
    const id = chromeWindow(run);
    const initialRect = geometry(run, id);
    position(calibration, initialRect);
    run('xdotool', ['windowactivate','--sync',id]);
    assertChromeFocused(run, id);
    run('xclip', ['-selection','clipboard'], action.conversation_url);
    run('xdotool', ['key','--clearmodifiers','ctrl+l']);
    run('xdotool', ['key','--clearmodifiers','ctrl+v']);
    run('xdotool', ['key','--clearmodifiers','Return']);
    await wait(3000);
    assertChromeFocused(run, id);
    // Unique sentinel prevents a stale clipboard URL from passing verification.
    const sentinel = 'aicafe-clipboard-verification-' + randomUUID();
    run('xclip', ['-selection','clipboard'], sentinel);
    run('xdotool', ['key','--clearmodifiers','ctrl+l']);
    run('xdotool', ['key','--clearmodifiers','ctrl+c']);
    await wait(200);
    assertChromeFocused(run, id);
    const actual = run('xclip', ['-selection','clipboard','-o']).replace(/\/$/, '');
    // Address-bar check only: no inspection of chat output or history.
    if (actual !== action.conversation_url) {
      await markReceipt(state.receipts, receipt, 'needs_login', 'Expected conversation URL did not remain open');
      return { status:'needs_login', id: action.id };
    }
    const rect = geometry(run, id);
    const pointer = position(calibration, rect);
    assertChromeFocused(run, id);
    run('xdotool', ['key','--clearmodifiers','Escape']);
    run('xdotool', ['mousemove','--sync',String(pointer.x),String(pointer.y)]);
    run('xdotool', ['click','1']);
    assertChromeFocused(run, id);
    reachedComposer = true;
    run('xclip', ['-selection','clipboard'], action.prompt);
    run('xdotool', ['key','--clearmodifiers','ctrl+v']);
    await wait(350);
    run('xdotool', ['key','--clearmodifiers','Return']);
    await markReceipt(state.receipts, receipt, 'submitted_unverified',
      'Enter key sent to calibrated Chrome editor; no receipt from provider');
    return { status:'submitted_unverified', id: action.id };
  } catch (err) {
    await markReceipt(state.receipts, receipt, reachedComposer ? 'uncertain' : 'not_submitted',
      reachedComposer ? 'Browser interaction may have occurred; never retry automatically' : 'Preflight failed before editor interaction');
    throw err;
  } finally {
    if (sessionLock) {
      await sessionLock.close();
      await fs.unlink(lockFile);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, file] = argv;
  if (command === 'doctor') {
    if (!process.env.DISPLAY) throw new Error('Open Terminal from inside the AWS Ubuntu graphical desktop');
    for (const tool of ['xdotool','xclip']) systemRun('which',[tool]);
    const id = chromeWindow(systemRun);
    console.log('PASS: exactly one Chrome window (' + id + ') on DISPLAY ' + process.env.DISPLAY);
    console.log('No message sent; no chat output read.');
  } else if (command === 'calibrate') {
    await calibrate();
  } else if (command === 'send') {
    if (!file || !path.isAbsolute(file)) throw new Error('Use an absolute path to a private action JSON file');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077))
      throw new Error('Action file must be a private regular file (chmod 600)');
    const result = await sendOnce(JSON.parse(await fs.readFile(file,'utf8')));
    console.log('Action ' + result.id + ': ' + result.status + '. Do NOT assume the site accepted it.');
  } else {
    throw new Error('Usage: node aws-desktop.mjs doctor | calibrate | send /absolute/private/action.json');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
