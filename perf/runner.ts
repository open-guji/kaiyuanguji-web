import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROFILES, findProfile, type NetworkProfile } from './profiles.ts';
import { SCENARIOS, findScenarios, type Scenario, type ActionType } from './scenarios.ts';
import {
    NetworkCollector,
    installPerfHooks,
    readPerceivedTiming,
    applyThrottling,
    clearThrottling,
    waitForLcp,
} from './collector.ts';
import { renderMarkdown, renderJson, type ScenarioRun, type RunReport } from './report.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliOptions {
    target: string;
    scenarios?: string;
    profiles?: string;
    out: string;
    headed: boolean;
    execPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
    const args = argv.slice(2);
    const opts: CliOptions = {
        target: 'https://www.kaiyuanguji.com',
        out: resolve(__dirname, 'out'),
        headed: false,
        execPath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--target') opts.target = args[++i];
        else if (a.startsWith('--target=')) opts.target = a.slice('--target='.length);
        else if (a === '--scenario' || a === '--scenarios') opts.scenarios = args[++i];
        else if (a.startsWith('--scenario=')) opts.scenarios = a.slice('--scenario='.length);
        else if (a.startsWith('--scenarios=')) opts.scenarios = a.slice('--scenarios='.length);
        else if (a === '--profile' || a === '--profiles') opts.profiles = args[++i];
        else if (a.startsWith('--profile=')) opts.profiles = a.slice('--profile='.length);
        else if (a.startsWith('--profiles=')) opts.profiles = a.slice('--profiles='.length);
        else if (a === '--out') opts.out = resolve(args[++i]);
        else if (a.startsWith('--out=')) opts.out = resolve(a.slice('--out='.length));
        else if (a === '--headed') opts.headed = true;
        else if (a === '--exec-path') opts.execPath = args[++i];
        else if (a.startsWith('--exec-path=')) opts.execPath = a.slice('--exec-path='.length);
        else if (a === '--help' || a === '-h') {
            printHelp();
            process.exit(0);
        }
    }
    return opts;
}

function printHelp() {
    console.log(`Usage: tsx runner.ts [options]

Options:
  --target <url>         Base URL (default: https://www.kaiyuanguji.com)
  --scenarios <ids>      Comma-separated scenario IDs/prefixes (default: all)
  --profiles <names>     Comma-separated profile names (default: all)
  --out <dir>            Output dir for report.md / report.json
  --headed               Run with visible browser (debug)
  --exec-path <path>     Use a custom Chromium binary (e.g. /usr/bin/chromium-browser)
                         Also: env var PLAYWRIGHT_CHROMIUM_PATH
  -h, --help             Show this

Available scenarios:
${SCENARIOS.map((s) => `  ${s.id.padEnd(28)} ${s.name}`).join('\n')}

Available profiles:
${PROFILES.map((p) => `  ${p.name.padEnd(10)} ${p.label}`).join('\n')}
`);
}

function pickProfiles(arg: string | undefined): NetworkProfile[] {
    if (!arg) return PROFILES;
    return arg.split(',').map((x) => x.trim()).filter(Boolean).map(findProfile);
}

async function performAction(
    page: Page,
    base: string,
    action: ActionType,
    profile: NetworkProfile,
): Promise<void> {
    switch (action.kind) {
        case 'goto': {
            const url = new URL(action.path, base).toString();
            await page.goto(url, { waitUntil: 'commit' });
            break;
        }
        case 'wait_selector':
            await page.waitForSelector(action.selector, { timeout: action.timeoutMs ?? 30000 });
            break;
        case 'click':
            await page.click(action.selector);
            break;
        case 'fill':
            await page.fill(action.selector, action.value);
            break;
        case 'wait_ms':
            await page.waitForTimeout(action.ms);
            break;
        case 'wait_idle': {
            const timeout = action.timeoutMs ?? profile.defaultIdleTimeoutMs;
            await page.waitForLoadState('networkidle', { timeout }).catch((e) => {
                throw new Error(`networkidle timeout (${timeout}ms): ${e.message}`);
            });
            break;
        }
        case 'wait_lcp': {
            const timeout = action.timeoutMs ?? Math.min(profile.defaultIdleTimeoutMs, 60000);
            const lcp = await waitForLcp(page, timeout);
            if (lcp === null) throw new Error(`LCP not observed within ${timeout}ms`);
            break;
        }
    }
}

async function runOne(
    browser: Browser,
    base: string,
    scenario: Scenario,
    profile: NetworkProfile,
): Promise<ScenarioRun> {
    const errors: string[] = [];
    const context: BrowserContext = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Linux; Android 12; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2,
        // Disable HTTP cache so every run measures cold load.
        bypassCSP: false,
    });
    await context.clearCookies();

    const collector = new NetworkCollector(context);
    collector.start();

    const page: Page = await context.newPage();
    await installPerfHooks(page);

    const cdp: CDPSession = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await applyThrottling(cdp, profile.downloadBps, profile.uploadBps, profile.latencyMs);

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
        for (const action of scenario.actions) {
            await performAction(page, base, action, profile);
        }
    } catch (e: any) {
        errors.push(`${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`);
    }
    const durationMs = Date.now() - t0;

    const timing = await readPerceivedTiming(page);
    const requests = collector.snapshot();

    await clearThrottling(cdp).catch(() => {});
    await context.close();

    return {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        profileName: profile.name,
        profileLabel: profile.label,
        baseUrl: base,
        startedAt,
        durationMs,
        timing,
        requests,
        errors,
    };
}

async function main() {
    const opts = parseArgs(process.argv);
    const scenarios = findScenarios(opts.scenarios);
    const profiles = pickProfiles(opts.profiles);

    console.log(`target:    ${opts.target}`);
    console.log(`scenarios: ${scenarios.map((s) => s.id).join(', ')}`);
    console.log(`profiles:  ${profiles.map((p) => p.name).join(', ')}`);
    console.log(`out:       ${opts.out}`);
    console.log('');

    await mkdir(opts.out, { recursive: true });

    // Disable any disk-/memory-cache reuse across contexts — keeps measurements
    // honest after redeploys. Without these flags chromium can serve stale
    // images from its in-process cache even though every context is "isolated".
    const cacheKillArgs = [
        '--disable-application-cache',
        '--disable-back-forward-cache',
        '--disk-cache-size=1',
        '--media-cache-size=1',
    ];
    const browser = await chromium.launch({
        headless: !opts.headed,
        executablePath: opts.execPath,
        args: opts.execPath
            ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', ...cacheKillArgs]
            : cacheKillArgs,
    });

    const startedAt = new Date().toISOString();
    const runs: ScenarioRun[] = [];

    let i = 0;
    const total = scenarios.length * profiles.length;
    for (const scenario of scenarios) {
        for (const profile of profiles) {
            i++;
            const tag = `[${i}/${total}] ${scenario.id} × ${profile.name}`;
            process.stdout.write(`${tag} … `);
            try {
                const run = await runOne(browser, opts.target, scenario, profile);
                const totalBytes = run.requests.reduce((s, r) => s + r.encodedBytes, 0);
                const lcp = run.timing.lcp == null ? '—' : `${(run.timing.lcp / 1000).toFixed(2)}s`;
                console.log(
                    `${run.requests.length} reqs, ${(totalBytes / 1024).toFixed(0)} KB, LCP ${lcp}, total ${(run.durationMs / 1000).toFixed(1)}s` +
                        (run.errors.length > 0 ? ` ⚠${run.errors.length}` : ''),
                );
                runs.push(run);
            } catch (e: any) {
                console.log(`FAILED: ${e?.message ?? e}`);
                runs.push({
                    scenarioId: scenario.id,
                    scenarioName: scenario.name,
                    profileName: profile.name,
                    profileLabel: profile.label,
                    baseUrl: opts.target,
                    startedAt: new Date().toISOString(),
                    durationMs: 0,
                    timing: { fcp: null, lcp: null, dcl: null, load: null },
                    requests: [],
                    errors: [`runner: ${e?.message ?? e}`],
                });
            }
        }
    }
    const finishedAt = new Date().toISOString();

    await browser.close();

    const report: RunReport = {
        target: opts.target,
        startedAt,
        finishedAt,
        runs,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const mdPath = resolve(opts.out, `report-${stamp}.md`);
    const jsonPath = resolve(opts.out, `report-${stamp}.json`);
    const latestMd = resolve(opts.out, 'latest.md');
    const latestJson = resolve(opts.out, 'latest.json');

    const md = renderMarkdown(report);
    const json = renderJson(report);

    await writeFile(mdPath, md, 'utf-8');
    await writeFile(jsonPath, json, 'utf-8');
    await writeFile(latestMd, md, 'utf-8');
    await writeFile(latestJson, json, 'utf-8');

    console.log('');
    console.log(`✓ ${mdPath}`);
    console.log(`✓ ${jsonPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
