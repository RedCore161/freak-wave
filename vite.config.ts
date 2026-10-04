import { defineConfig, loadEnv, type Plugin } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Balancing mode (BALANCING_MODE=1, or `npm run dev:balance`): the dev server
 * lets the in-game balancing panel save config.json, serve the auto-balance
 * report and start an auto-balance run. Never part of a production build.
 */
function balancePlugin(): Plugin {
  let child: ChildProcess | null = null;
  let output = '';
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  return {
    name: 'freakwave-balance',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/__balance/')) return next();
        if (url === '/__balance/config' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            try {
              const cfg = JSON.parse(body);
              if (!cfg.rules || !cfg.chaos || !cfg.skills || !cfg.levels) throw new Error('not a config');
              writeFileSync('config.json', JSON.stringify(cfg, null, 2) + '\n');
              json(res, 200, { ok: true });
            } catch (err) {
              json(res, 400, { ok: false, error: String(err) });
            }
          });
          return;
        }
        if (url === '/__balance/report') {
          if (!existsSync('balance/report.html')) return json(res, 404, { error: 'No report yet. Run the auto-balancer.' });
          res.setHeader('Content-Type', 'text/html');
          res.end(readFileSync('balance/report.html'));
          return;
        }
        if (url === '/__balance/run' && req.method === 'POST') {
          if (child) return json(res, 409, { ok: false, error: 'already running' });
          output = '';
          child = spawn(process.execPath, ['scripts/balance.ts'], { cwd: process.cwd() });
          child.stdout?.on('data', (d) => (output += d));
          child.stderr?.on('data', (d) => (output += d));
          child.on('close', (code) => {
            output += `\n[exit ${code}]`;
            child = null;
          });
          return json(res, 200, { ok: true });
        }
        if (url === '/__balance/status') return json(res, 200, { running: !!child, log: output.slice(-4000) });
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['VITE_', 'BALANCING_']);
  const balancing = ['1', 'true', 'yes'].includes(String(process.env.BALANCING_MODE ?? env.BALANCING_MODE ?? '').toLowerCase());
  return {
    envPrefix: ['VITE_', 'BALANCING_'],
    define: { __BALANCING__: JSON.stringify(balancing) },
    plugins: balancing ? [balancePlugin()] : [],
    server: {
      // Saving config.json from the panel must not reload the page mid-test.
      watch: { ignored: ['**/config.json', '**/balance/**', '**/.cache/**'] },
    },
  };
});
