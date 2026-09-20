import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./lab-provision.mjs', import.meta.url));

function runProvision(url, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        STAGING_URL: url,
        LAB_SEED: 'machine-lab-contract',
        GITHUB_RUN_ID: 'provision-test',
        // A contract test must not publish its fixture team as a real Actions
        // step output when it runs inside CI.
        GITHUB_OUTPUT: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function startFixture(t, handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

test('provisioning explicitly starts Team evaluation before governance writes', async (t) => {
  const requests = [];
  let evaluationStarted = false;
  const runId = 'provision-test';
  const slug = createHmac('sha256', 'machine-lab-contract')
    .update(`team:${runId}`)
    .digest('hex')
    .slice(0, 8);
  const team = `lab-${slug}`;
  const token = `stma_${'a'.repeat(40)}`;

  const url = await startFixture(t, async (request, response) => {
    const requestBody = await body(request);
    requests.push({
      path: request.url,
      method: request.method,
      body: requestBody,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });

    if (request.url === '/auth/local/signup') {
      response.writeHead(302, { location: '/app', 'set-cookie': 'sid=fixture; Path=/; HttpOnly' });
      return response.end();
    }
    if (request.url === '/app/teams') {
      assert.equal(request.headers.cookie, 'sid=fixture');
      response.writeHead(302, { location: `/app/teams/${team}` });
      return response.end();
    }
    if (request.url === `/app/teams/${team}/evaluation`) {
      assert.equal(request.headers.cookie, 'sid=fixture');
      evaluationStarted = true;
      response.writeHead(303, { location: `/app/teams/${team}/evaluation` });
      return response.end();
    }
    if (request.url === '/app/tokens') {
      assert.equal(evaluationStarted, true);
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end(token);
    }
    if (
      request.url === '/api/control/policies' ||
      request.url === '/api/control/environment-baselines'
    ) {
      assert.equal(evaluationStarted, true, 'governance write happened before evaluation');
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end('{}');
    }
    response.writeHead(404);
    return response.end();
  });

  const result = await runProvision(url);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`provisioned team ${team}`));
  assert.deepEqual(
    requests.map((request) => request.path),
    [
      '/auth/local/signup',
      '/app/teams',
      `/app/teams/${team}/evaluation`,
      '/app/tokens',
      '/api/control/policies',
      '/api/control/environment-baselines',
    ],
  );
});

test('provisioning fails closed when the evaluation cannot be started', async (t) => {
  const requests = [];
  const url = await startFixture(t, async (request, response) => {
    requests.push(request.url);
    await body(request);
    if (request.url === '/auth/local/signup') {
      response.writeHead(302, { location: '/app', 'set-cookie': 'sid=fixture; Path=/' });
      return response.end();
    }
    if (request.url === '/app/teams') {
      response.writeHead(302, { location: '/app/teams/fixture' });
      return response.end();
    }
    response.writeHead(409, { 'content-type': 'text/plain' });
    return response.end('evaluation unavailable');
  });

  const result = await runProvision(url);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Team evaluation failed \(409\): evaluation unavailable/);
  assert.equal(requests.some((path) => path === '/app/tokens'), false);
  assert.equal(requests.some((path) => path?.startsWith('/api/control/')), false);
});
